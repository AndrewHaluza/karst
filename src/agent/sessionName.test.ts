import { describe, expect, it } from 'vitest';
import { SESSION_NAME_MAX, sanitizeSessionName } from './sessionName.js';

describe('sanitizeSessionName', () => {
  it('keeps an ordinary rendered terminal name unchanged', () => {
    expect(sanitizeSessionName('Karst: PROJ-42 — Fix login')).toBe(
      'Karst: PROJ-42 — Fix login',
    );
  });

  it('collapses newlines and control characters to single spaces', () => {
    expect(sanitizeSessionName('Karst: PROJ-1\nsecond line\tand\u0007bell')).toBe(
      'Karst: PROJ-1 second line and bell',
    );
  });

  it('trims surrounding whitespace', () => {
    expect(sanitizeSessionName('  Karst: PROJ-1  ')).toBe('Karst: PROJ-1');
  });

  it('caps an unbounded title so the picker row stays readable', () => {
    const long = `Karst: PROJ-1 — ${'x'.repeat(400)}`;
    const out = sanitizeSessionName(long)!;
    expect(out.length).toBe(SESSION_NAME_MAX);
    expect(long.startsWith(out)).toBe(true);
  });

  it('returns undefined for absent or whitespace-only names', () => {
    expect(sanitizeSessionName(undefined)).toBeUndefined();
    expect(sanitizeSessionName('')).toBeUndefined();
    expect(sanitizeSessionName('   \n\t ')).toBeUndefined();
  });
});
