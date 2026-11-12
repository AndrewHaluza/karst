import { describe, expect, it } from 'vitest';
import { deliverFailureLine, deliverHint, deliverProgressLine, deliverTakeOverLine, groupFailuresByHead, mergeStateWording, shortSha, type DeliverFacts } from './deliver.js';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const base: DeliverFacts = { running: null, failures: [], takenOver: null, roundActive: false, headSha: A };
const fail = { gate: 'unit', repo: 'r', exitCode: 2, headSha: A, summary: 'boom' };

describe('deliver wording', () => {
  it('words the progress line only while a gate runs', () => {
    expect(deliverProgressLine(base)).toBeNull();
    expect(deliverProgressLine({ ...base, running: { n: 2, m: 5, gate: 'docs' } })).toBe('Delivering resolved merge: gate 2/5 (docs), push after the gates');
  });
  it('a failure on the current head wins over the running hint', () => {
    expect(deliverHint({ ...base, running: { n: 2, m: 5, gate: 'docs' }, failures: [fail] })).toBe(`Gate unit failed (exit 2) on ${'a'.repeat(9)}. Deliver now pushes it anyway.`);
  });
  it('a failure of an older head gives no hint', () => {
    expect(deliverHint({ ...base, headSha: B, failures: [fail] })).toBeNull();
  });
  it('words the failure, the takeover and the short sha', () => {
    expect(deliverFailureLine({ ...fail, headSha: null })).toBe('Gate unit failed (exit 2) on unknown head');
    expect(shortSha(A)).toHaveLength(9);
    expect(deliverTakeOverLine({ failed: ['unit'], skipped: [] })).toBe('Delivery taken over by a manual Deliver; failed: unit; skipped: none');
  });
  it('groups failures by head in order', () => {
    const g = groupFailuresByHead([fail, { ...fail, gate: 'docs' }, { ...fail, headSha: B }]);
    expect(g.map((x) => [x.headSha, x.items.length])).toEqual([[A, 2], [B, 1]]);
  });
  it('words clean as the local merge only while a round is active', () => {
    expect(mergeStateWording('clean', true)).toBe('clean (the local merge commit, not on the PR yet)');
    expect(mergeStateWording('clean', false)).toBe('clean');
    expect(mergeStateWording('conflict', true)).toBe('conflict');
  });

  it('words the progress of an after-take-over run without a push', () => {
    const f = { ...base, running: { n: 1, m: 2, gate: 'integration', afterTakeOver: true }, roundActive: true };
    expect(deliverProgressLine(f)).toBe('Running the gates skipped by the manual Deliver: gate 1/2 (integration)');
    expect(deliverHint(f)).toBeNull();
  });
  it('tells that Deliver pushes at once and the skipped gates run after the push', () => {
    expect(deliverHint({ ...base, running: { n: 2, m: 5, gate: 'docs' } })).toBe('Auto-deliver runs gate 2/5 (docs). Deliver now pushes at once; the skipped gates run after the push.');
  });
});
