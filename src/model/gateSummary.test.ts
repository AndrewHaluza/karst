import { describe, it, expect } from 'vitest';
import {
  summarizeGateFailure,
  failingTestIds,
  MAX_GATE_SUMMARY_LINES,
  MAX_GATE_SUMMARY_CHARS,
} from './gateSummary.js';

describe('summarizeGateFailure', () => {
  it('returns null for empty or whitespace-only output', () => {
    expect(summarizeGateFailure('')).toBeNull();
    expect(summarizeGateFailure('   \n\t \n')).toBeNull();
  });

  it('keeps the trailing non-empty lines — where failure tooling prints the actionable errors', () => {
    const out = ['Checking formatting...', 'src/pages/index.vue:23:9 Replace `x` with `y`'].join('\n');
    const summary = summarizeGateFailure(out);
    expect(summary).toContain('src/pages/index.vue:23:9');
    expect(summary).toContain('Checking formatting...');
  });

  it('drops leading lines beyond the tail window, keeping the errors at the end', () => {
    const preamble = Array.from({ length: MAX_GATE_SUMMARY_LINES + 5 }, (_, k) => `line ${k}`).join('\n');
    const out = `${preamble}\nsrc/db.ts:42:3 the actual error`;
    const summary = summarizeGateFailure(out)!;
    expect(summary).toContain('src/db.ts:42:3 the actual error');
    expect(summary).not.toContain('line 0');
  });

  it('trims whitespace from each line before keeping it', () => {
    const summary = summarizeGateFailure('  \n   error one   \n\t\nerror two\n');
    expect(summary).toBe('error one\nerror two');
  });

  it('caps the total length, keeping the END of the excerpt and marking the cut', () => {
    const long = Array.from(
      { length: MAX_GATE_SUMMARY_LINES },
      (_, k) => `xxxxxxxxxxxx ${k} ${'y'.repeat(100)}`,
    ).join('\n');
    const summary = summarizeGateFailure(long)!;
    expect(summary.length).toBeLessThanOrEqual(MAX_GATE_SUMMARY_CHARS);
    expect(summary.startsWith('…')).toBe(true);
  });

  it('returns the whole output when it fits within the bounds', () => {
    const out = 'one\ntwo';
    expect(summarizeGateFailure(out)).toBe('one\ntwo');
  });
});

describe('vitest output', () => {
  const E = '\u001b';
  const out = [
    `${E}[31m FAIL ${E}[39m src/a.test.ts > suite > does a thing`,
    `${E}[31m FAIL ${E}[39m src/a.test.ts > suite > does a thing`,
    ...Array.from({ length: 30 }, (_, i) => `${E}[2mnoise ${i}${E}[22m`),
    `${E}[2m  324|${E}[22m expect(proc.calls).toEqual([])`,
    ' Test Files  1 failed (1)',
  ].join('\n');

  it('extracts deduped failing ids without ESC', () => {
    expect(failingTestIds(out)).toEqual(['src/a.test.ts > suite > does a thing']);
  });

  it('leads with FAIL lines, strips ESC, respects the cap', () => {
    const s = summarizeGateFailure(out)!;
    expect(s.startsWith('FAIL src/a.test.ts > suite > does a thing\n')).toBe(true);
    expect(s).toContain('Test Files');
    expect(s).not.toContain(E);
    expect(s.length).toBeLessThanOrEqual(MAX_GATE_SUMMARY_CHARS);
  });

  it('leaves non-vitest output as a plain tail', () => {
    expect(failingTestIds('FAIL x > y\nboom')).toEqual(['x > y']);
    expect(summarizeGateFailure('FAIL x > y\nboom')).toBe('FAIL x > y\nboom');
  });
});
