import { describe, it, expect } from 'vitest';
import { collapseDiagnostic, MAX_DIAGNOSTIC_CHARS } from './diagnosticText.js';

/**
 * The shared collapse-and-cap for untrusted diagnostic prose (git stderr,
 * gate output, …) before it reaches a rendered surface. Same shape as the
 * private `oneLine`/`cap` pair `agent/cliFailure.ts` already used for a
 * failed headless run — pulled out here so a second call site (a stage's
 * verdict/blocked reason) does not grow its own copy.
 */
describe('collapseDiagnostic', () => {
  it('collapses runs of whitespace, including newlines, to a single space', () => {
    expect(collapseDiagnostic('line one\nline two\n\nline three')).toBe('line one line two line three');
  });

  it('trims leading and trailing whitespace', () => {
    expect(collapseDiagnostic('  \n  hello  \n  ')).toBe('hello');
  });

  it('leaves short single-line text untouched', () => {
    expect(collapseDiagnostic('no target resolved')).toBe('no target resolved');
  });

  it('caps to the given max, appending an ellipsis, without exceeding it', () => {
    const long = 'x'.repeat(50);
    const out = collapseDiagnostic(long, 10);
    expect(out).toBe(`${'x'.repeat(10)}…`);
    expect(out.length).toBeLessThanOrEqual(11);
  });

  it('defaults to MAX_DIAGNOSTIC_CHARS when no max is given', () => {
    const long = 'y'.repeat(MAX_DIAGNOSTIC_CHARS + 500);
    const out = collapseDiagnostic(long);
    expect(out.length).toBe(MAX_DIAGNOSTIC_CHARS + 1); // +1 for the ellipsis
    expect(out.endsWith('…')).toBe(true);
  });

  it('collapses BEFORE capping, so a huge run of whitespace does not exhaust the budget', () => {
    // Capping the raw 50,002-char string first would truncate mid-whitespace
    // and produce "a    …"; collapsing first reduces it to "a b" (3 chars),
    // which fits the cap untouched.
    const out = collapseDiagnostic(`a${' '.repeat(50_000)}b`, 5);
    expect(out).toBe('a b');
  });
});
