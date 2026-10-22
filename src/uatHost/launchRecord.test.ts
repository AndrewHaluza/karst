import { describe, expect, it } from 'vitest';
import { ARGV_INLINE_MAX, buildLaunchRecord, normalizeLaunch, parseLaunches } from './launchRecord.js';

const base = { provider: 'claude', envKeys: ['B', 'A'], cwd: '/w', readFile: () => undefined };

describe('buildLaunchRecord', () => {
  it('keeps short argv, sorts env keys, never carries values', () => {
    const r = buildLaunchRecord({ ...base, argv: ['--x', 'y'] });
    expect(r).toEqual({ provider: 'claude', argv: ['--x', 'y'], envKeys: ['A', 'B'], cwd: '/w' });
  });
  it('summarizes an entry over the inline limit as len, sha256 and a 200 char head', () => {
    const long = 'a'.repeat(ARGV_INLINE_MAX + 1);
    const [a] = buildLaunchRecord({ ...base, argv: [long] }).argv;
    expect(a).toMatchObject({ len: ARGV_INLINE_MAX + 1, head: 'a'.repeat(200) });
    expect(typeof a === 'object' && a.sha256).toMatch(/^[0-9a-f]{64}$/);
  });
  it('keeps an entry of exactly the inline limit whole', () => {
    const edge = 'a'.repeat(ARGV_INLINE_MAX);
    expect(buildLaunchRecord({ ...base, argv: [edge] }).argv).toEqual([edge]);
  });
  it('reads the file a spill pointer names and records its length and hash', () => {
    const reads: string[] = [];
    const r = buildLaunchRecord({
      ...base,
      argv: ['Your full kickoff brief is in /wt/.karst/kickoff/k.md; read it completely before doing anything else.'],
      readFile: (p) => { reads.push(p); return Buffer.from('hello'); },
    });
    expect(reads).toEqual(['/wt/.karst/kickoff/k.md']);
    expect(r.spill).toEqual({ len: 5, sha256: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824' });
  });
  it('omits spill when the pointed file is unreadable or no pointer exists', () => {
    expect(buildLaunchRecord({ ...base, argv: ['plain'] }).spill).toBeUndefined();
    const ptr = 'Your full kickoff brief is in /gone.md; read it completely';
    expect(buildLaunchRecord({ ...base, argv: [ptr] }).spill).toBeUndefined();
  });
});

describe('parseLaunches / normalizeLaunch', () => {
  it('strips the scratch dir and hook settings suffix', () => {
    const r = normalizeLaunch({
      provider: 'claude', envKeys: [], cwd: '/tmp/karst-uat-host-C9Rotl/w',
      argv: ['/tmp/karst-uat-host-C9Rotl/karst-hooks.38825.1491f08a4102678c.settings.json'],
    });
    expect(r.cwd).toBe('/tmp/karst-uat-host-<run>/w');
    expect(r.argv).toEqual(['/tmp/karst-uat-host-<run>/karst-hooks.<id>.settings.json']);
  });
  it('skips blank and torn lines', () => {
    const good = JSON.stringify({ provider: 'codex', argv: [], envKeys: [], cwd: '/w' });
    expect(parseLaunches(`${good}\n\n{"provider"\n`)).toHaveLength(1);
  });
  it('strips the workspace hash from cwd and argv', () => {
    const r = normalizeLaunch({
      provider: 'claude', envKeys: [], cwd: '/t/workspace-0123abcd/r',
      argv: ['/t/workspace-0123abcd/x', { len: 600, sha256: 's', head: 'workspace-89abcdef' }],
    });
    expect(r.cwd).toBe('/t/workspace-<hash>/r');
    expect(r.argv).toEqual(['/t/workspace-<hash>/x', { len: 600, sha256: 's', head: 'workspace-<hash>' }]);
  });
});
