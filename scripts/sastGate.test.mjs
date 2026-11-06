import { describe, it, expect } from 'vitest';
import { planSast, scopeLine, semgrepArgs } from './sastGate.mjs';

const base = { sha: 'abc', tried: ['develop'], exists: () => true };

describe('planSast', () => {
  it('scans the changed src files that exist', () => {
    const plan = planSast({ ...base, changed: ['src/b.ts', 'src/a.ts', 'docs/x.md', 'scripts/s.mjs'], exists: (f) => f !== 'src/gone.ts' });
    expect(plan).toEqual({ kind: 'files', files: ['src/a.ts', 'src/b.ts'] });
  });
  it('skips when only docs changed', () => {
    expect(planSast({ ...base, changed: ['docs/x.md'] })).toEqual({ kind: 'none' });
  });
  it('skips when the changed src files were deleted', () => {
    expect(planSast({ ...base, changed: ['src/a.ts'], exists: () => false })).toEqual({ kind: 'none' });
  });
  it('does not match a path that only starts with src', () => {
    expect(planSast({ ...base, changed: ['srcfoo/a.ts'] })).toEqual({ kind: 'none' });
  });
  it('falls back to a full scan when the base is not found', () => {
    expect(planSast({ sha: null, tried: ['a', 'b'], changed: null, exists: () => true })).toEqual({ kind: 'full', reason: 'no merge base for a, b' });
  });
  it('falls back to a full scan when git diff fails', () => {
    expect(planSast({ ...base, changed: null }).kind).toBe('full');
  });
  it('runs the full scan when .semgrepignore changed', () => {
    expect(planSast({ ...base, changed: ['.semgrepignore'] })).toEqual({ kind: 'full', reason: '.semgrepignore changed' });
  });
});

describe('scopeLine and semgrepArgs', () => {
  const flags = ['--config', 'p/typescript', '--metrics=off', '--error', '--quiet', '--jobs', '2'];
  it('passes the files after -- for a file scan', () => {
    const plan = { kind: 'files', files: ['src/a.ts'] };
    expect(semgrepArgs(plan)).toEqual(['scan', ...flags, '--', 'src/a.ts']);
    expect(scopeLine(plan)).toBe('sast: 1 changed file(s) under src');
  });
  it('passes src for a full scan and names the reason', () => {
    const plan = { kind: 'full', reason: 'why' };
    expect(semgrepArgs(plan)).toEqual(['scan', ...flags, 'src']);
    expect(scopeLine(plan)).toContain('full scan of src (why)');
  });
  it('names the skip', () => expect(scopeLine({ kind: 'none' })).toContain('skipping semgrep'));
});
