import { describe, expect, it } from 'vitest';
import { deliverFailureLine, deliverHint, deliverProgressLine, deliverTakeOverLine, groupFailuresByHead, mergeStateWording, wordResolvedConflict, shortSha, withDeliverWait, type DeliverFacts } from './deliver.js';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const base: DeliverFacts = { running: null, failures: [], takenOver: null, roundActive: false, headSha: A };
const fail = { gate: 'unit', repo: 'r', exitCode: 2, headSha: A, summary: 'boom' };

describe('deliver wording', () => {
  it('words the progress line only while a gate runs', () => {
    expect(deliverProgressLine(base)).toBeNull();
    expect(deliverProgressLine({ ...base, running: { n: 2, m: 5, gate: 'docs' } })).toBe('Delivering resolved merge: gate 2/5 (docs), push after the gates');
    expect(deliverProgressLine({ ...base, running: { n: 2, m: 5, gate: 'docs', waiting: true } })).toBe('Delivering resolved merge: gate 2/5 (docs) waits for a slot');
    expect(deliverProgressLine({ ...base, running: { n: 2, m: 5, gate: 'docs', afterTakeOver: true, waiting: true } })).toBe('Running the gates skipped by the manual Deliver: gate 2/5 (docs) waits for a slot');
  });
  it('words a base-moved run as a check before the push, not an auto-deliver (D541)', () => {
    expect(deliverProgressLine({ ...base, running: { n: 2, m: 5, gate: 'docs', baseCheck: true } })).toBe('Checking before push: gate 2/5 (docs) on the merge with the current base; the push follows only if every gate passes');
    expect(deliverProgressLine({ ...base, running: { n: 2, m: 5, gate: 'docs', baseCheck: true, waiting: true } })).toBe('Checking before push: gate 2/5 (docs) waits for a slot');
    expect(deliverProgressLine({ ...base, running: { n: 2, m: 5, gate: 'docs', baseCheck: false } })).toBe('Delivering resolved merge: gate 2/5 (docs), push after the gates');
  });
  it('a failure on the current head wins over the running hint', () => {
    const hint = deliverHint({ ...base, running: { n: 2, m: 5, gate: 'docs' }, failures: [fail] });
    expect(hint).toBe(`Gate unit failed (exit 2) on ${'a'.repeat(9)}. Push runs the gates again on the merge with the current base and pushes only if they pass.`);
    expect(hint).not.toContain('anyway');
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
  it('keeps the plain state when the local head is the PR head', () => {
    expect(mergeStateWording('clean', { localHead: A, prHead: A, mergeBlock: 'clean' })).toBe('clean');
  });
  it('words clean locally with the GitHub state when the heads differ and no round runs (T1099)', () => {
    expect(mergeStateWording('clean', { localHead: A, prHead: B, mergeBlock: 'dirty' })).toBe(`clean locally on ${shortSha(A)} (not pushed; GitHub: dirty)`);
  });
  it('words the same for a conflict round (T1120): the facts decide, not the round', () => {
    expect(mergeStateWording('clean', { localHead: A, prHead: B, mergeBlock: 'blocked' })).toBe(`clean locally on ${shortSha(A)} (not pushed; GitHub: blocked)`);
  });
  it('says GitHub did not state a merge block', () => {
    expect(mergeStateWording('clean', { localHead: A, prHead: B, mergeBlock: null })).toBe(`clean locally on ${shortSha(A)} (not pushed; GitHub: unknown)`);
  });
  it('says the GitHub head is unknown when no PR head is stored', () => {
    expect(mergeStateWording('clean', { localHead: A, prHead: null, mergeBlock: null })).toBe(`clean locally on ${shortSha(A)} (GitHub head unknown)`);
  });
  it('keeps the state when it is not clean or the local head is unknown', () => {
    expect(mergeStateWording('conflict', { localHead: A, prHead: B, mergeBlock: 'dirty' })).toBe('conflict');
    expect(mergeStateWording('clean', { localHead: null, prHead: B, mergeBlock: 'dirty' })).toBe('clean');
    expect(mergeStateWording('clean', undefined)).toBe('clean');
  });

  describe('a stored conflict reason after a local resolve (T1143)', () => {
    const stored = 'blocked: the pull request for "api" has changes and is not merged yet (a conflict in api).';
    const heads = (over: Partial<{ localHead: string | null; prHead: string | null }> = {}) =>
      new Map([['api', { localHead: A, prHead: B, mergeBlock: 'dirty', ...over }]]);
    it('words the resolved conflict when the clean head is not pushed', () => {
      expect(wordResolvedConflict(stored, heads())).toBe(`blocked: the pull request for "api" has changes and is not merged yet (conflict resolved locally on ${shortSha(A)}, push pending).`);
    });
    it('keeps the stored reason when the head is pushed, the PR head is unknown or the repo has no clean check', () => {
      expect(wordResolvedConflict(stored, heads({ prHead: A }))).toBe(stored);
      expect(wordResolvedConflict(stored, heads({ prHead: null }))).toBe(stored);
      expect(wordResolvedConflict(stored, new Map())).toBe(stored);
    });
    it('names each repo when several conflicts are resolved, and keeps the reason when one is not', () => {
      const multi = 'blocked: pull requests for api, web have changes and are not merged yet (conflicts in api, web).';
      const both = new Map([['api', { localHead: A, prHead: B, mergeBlock: null }], ['web', { localHead: B, prHead: A, mergeBlock: null }]]);
      expect(wordResolvedConflict(multi, both)).toBe(`blocked: pull requests for api, web have changes and are not merged yet (conflicts resolved locally: api on ${shortSha(A)}, web on ${shortSha(B)}; push pending).`);
      const one = new Map([['api', { localHead: A, prHead: B, mergeBlock: null }]]);
      expect(wordResolvedConflict(multi, one)).toBe(multi);
    });
    it('leaves a reason without a conflict note alone', () => {
      expect(wordResolvedConflict('blocked: x.', heads())).toBe('blocked: x.');
    });
  });

  it('words the progress of an after-take-over run without a push', () => {
    const f = { ...base, running: { n: 1, m: 2, gate: 'integration', afterTakeOver: true }, roundActive: true };
    expect(deliverProgressLine(f)).toBe('Running the gates skipped by the manual Deliver: gate 1/2 (integration)');
    expect(deliverHint(f)).toBeNull();
  });
  it('tells that Deliver stops the running gates and runs them again on a moved base before pushing', () => {
    expect(deliverHint({ ...base, running: { n: 2, m: 5, gate: 'docs' } })).toBe('Auto-deliver runs gate 2/5 (docs). Deliver stops these gates and pushes; if the base moved since the merge, the gates run on the new merge first.');
  });
});

describe('withDeliverWait and the gate facts (T1403)', () => {
  const facts = (): DeliverFacts => ({
    running: { n: 2, m: 3, gate: 'docs' },
    failures: [],
    takenOver: null,
    roundActive: true,
    headSha: 'a'.repeat(40),
    gates: [
      { name: 'unit', repo: 'r', status: 'pass', startedAt: 'T1', endedAt: 'T2', exitCode: 0 },
      { name: 'docs', repo: 'r', status: 'run', startedAt: null, endedAt: null, exitCode: null },
      { name: 'visual', repo: 'r', status: 'pending', startedAt: null, endedAt: null, exitCode: null },
    ],
  });

  it('marks the running gate fact as waiting with the live state', () => {
    const f = withDeliverWait(facts(), { docs: { kind: 'wait' } })!;
    expect(f.running?.waiting).toBe(true);
    expect(f.gates?.map((g) => g.status)).toEqual(['pass', 'wait', 'pending']);
  });

  it('leaves the gate facts alone when no live gate waits', () => {
    const f = facts();
    expect(withDeliverWait(f, { docs: { kind: 'run' } })).toBe(f);
    expect(withDeliverWait(f, undefined)).toBe(f);
  });

  it('adds no gate facts to facts that carry none', () => {
    const { gates: _g, ...without } = facts();
    const waited = withDeliverWait(without, { docs: { kind: 'wait' } })!;
    expect(waited.running?.waiting).toBe(true);
    expect('gates' in waited).toBe(false);
  });
});
