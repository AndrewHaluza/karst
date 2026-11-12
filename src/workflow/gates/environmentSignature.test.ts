import { describe, expect, it } from 'vitest';
import {
  ENVIRONMENT_SIGNATURE_PREFIX,
  environmentSignature,
  signatureOfSummary,
  summarizeWithSignature,
} from './environmentSignature.js';

describe('environmentSignature', () => {
  it.each([
    ['a test timeout', 'visual', 'Error: Test exceeded the test timeout of 60000ms', 'a gate or test timeout'],
    ['a webServer timeout', 'visual', 'Error: Timed out waiting 120000ms from config.webServer.', 'a gate or test timeout'],
    ['an unparseable base check', 'test:unit', 'base check skipped: some vitest failures are not parseable test ids', 'the base check could not parse the vitest failures'],
    ['a non-screenshot failure', 'visual', '1 failure is not a screenshot mismatch: [layout] layout.teardown', 'a failure that is not a screenshot mismatch'],
    ['plural non-screenshot failures', 'visual', '3 failures are not screenshot mismatches: x', 'a failure that is not a screenshot mismatch'],
    ['the 40-failure skip', 'visual', 'flake re-run skipped: 41 screenshots fail (cap 40), a real break', 'more than 40 failing screenshots (the host environment is suspect)'],
    ['the wholesale skip', 'visual', '41 screenshots fail (cap 40): base likely drifted wholesale', 'more than 40 failing screenshots (the host environment is suspect)'],
    ['the port window', 'test:integration', 'no free window of 4 ports in [4100, 4200]', 'no free port window'],
  ])('%s gives a reason', (_label, gate, output, reason) => {
    expect(environmentSignature(gate, output)).toBe(reason);
  });

  it('returns null for an assertion failure', () => {
    expect(environmentSignature('test:unit', 'FAIL a.test.ts > x\nAssertionError: expected 1 to be 2')).toBeNull();
  });

  it('returns null for empty output', () => {
    expect(environmentSignature('lint', '')).toBeNull();
  });

  it('strips ANSI before it matches', () => {
    expect(environmentSignature('visual', '\u001b[31mexceeded the test timeout\u001b[0m')).toBe('a gate or test timeout');
  });
});

describe('summarizeWithSignature', () => {
  it('leads the summary with the signature line', () => {
    const s = summarizeWithSignature('visual', 'boom\nexceeded the test timeout of 5ms');
    expect(s?.startsWith(`${ENVIRONMENT_SIGNATURE_PREFIX} a gate or test timeout\n`)).toBe(true);
    expect(signatureOfSummary(s)).toBe('a gate or test timeout');
  });

  it('keeps the plain summary when no signature matches', () => {
    expect(summarizeWithSignature('lint', 'error: bad')).toBe('error: bad');
    expect(signatureOfSummary('error: bad')).toBeNull();
  });

  it('returns null for blank output', () => {
    expect(summarizeWithSignature('lint', '  ')).toBeNull();
    expect(signatureOfSummary(null)).toBeNull();
  });

  it('finds the signature although the 600-char tail cut it', () => {
    const output = `exceeded the test timeout\n${'x'.repeat(50)}\n`.repeat(1) + Array.from({ length: 30 }, (_, i) => `line ${i} ${'y'.repeat(40)}`).join('\n');
    expect(signatureOfSummary(summarizeWithSignature('visual', output))).toBe('a gate or test timeout');
  });
});
