import { describe, it, expect } from 'vitest';
import { appendConstraintsToBrief } from './constraintBrief.js';

describe('appendConstraintsToBrief', () => {
  it('appends a heading and one line per entry after the summary', () => {
    expect(appendConstraintsToBrief('Decided X.\n', ['@arch:RESIDENT', '#88'])).toBe(
      'Decided X.\n\n## Design constraints\n- @arch:RESIDENT\n- #88',
    );
  });
  it('is only the block when the summary is blank', () => {
    expect(appendConstraintsToBrief('  ', ['#1'])).toBe('## Design constraints\n- #1');
  });
  it('never duplicates an existing heading', () => {
    const b = 'x\n\n## Design constraints\n- #1';
    expect(appendConstraintsToBrief(b, ['#2'])).toBe(b);
  });
  it('returns the brief untouched with no constraints', () => {
    expect(appendConstraintsToBrief('x', [])).toBe('x');
  });
});
