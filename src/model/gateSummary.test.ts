import { describe, it, expect } from 'vitest';
import {
  summarizeGateFailure,
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
