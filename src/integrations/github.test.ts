import { describe, it, expect } from 'vitest';
import { openPr, toGhResult, type GhRunner } from './github.js';
import { GH_DEPENDENCY, renderMissingDependency } from '../runtime/deps.js';

describe('toGhResult', () => {
  it('carries gh’s own stderr through', () => {
    expect(toGhResult({ stdout: 'out', stderr: 'boom', status: 1, error: undefined })).toEqual({
      stdout: 'out',
      stderr: 'boom',
      exitCode: 1,
    });
  });

  it('turns a missing gh into an instruction, not an ENOENT', () => {
    // `gh` not installed: spawnSync returns status null and null pipes, and the
    // real cause lives only on `error`. "spawnSync gh ENOENT" is true but tells a
    // user nothing they can act on — and this text is what the dashboard's fault
    // card shows them.
    const r = toGhResult({
      stdout: null,
      stderr: null,
      status: null,
      error: Object.assign(new Error('spawnSync gh ENOENT'), { code: 'ENOENT' }),
    });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).not.toContain('ENOENT');
    // Registry copy, not a second hand-written version of it: the fault card and
    // the setup checklist must not disagree about how to install gh.
    expect(r.stderr).toBe(renderMissingDependency(GH_DEPENDENCY));
  });

  it('reports any other spawn failure verbatim — gh never ran, so it said nothing', () => {
    const r = toGhResult({
      stdout: null,
      stderr: null,
      status: null,
      error: Object.assign(new Error('spawnSync gh EACCES'), { code: 'EACCES' }),
    });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('EACCES');
    expect(r.stderr).toContain('gh');
  });

  it('never yields an empty reason for a failure', () => {
    const r = toGhResult({ stdout: null, stderr: null, status: 1, error: undefined });
    expect(r.stderr!.length).toBeGreaterThan(0);
  });
});

describe('openPr', () => {
  it('runs `gh pr create` in the repo cwd and parses the returned URL', async () => {
    const calls: { args: string[]; cwd: string }[] = [];
    const gh: GhRunner = async (args, cwd) => {
      calls.push({ args, cwd });
      return { stdout: 'https://github.com/o/r/pull/7\n', exitCode: 0 };
    };
    const pr = await openPr(gh, { cwd: '/wt/a', title: 'T', body: 'desc' });
    expect(calls[0]!.args).toContain('pr');
    expect(calls[0]!.args).toContain('create');
    expect(calls[0]!.cwd).toBe('/wt/a');
    expect(pr.url).toBe('https://github.com/o/r/pull/7');
    expect(pr.number).toBe(7);
  });

  it('passes the title and body through to gh', async () => {
    const seen: string[] = [];
    const gh: GhRunner = async (args) => {
      seen.push(...args);
      return { stdout: 'https://github.com/o/r/pull/1', exitCode: 0 };
    };
    await openPr(gh, { cwd: '/wt', title: 'My Title', body: 'My Body' });
    expect(seen).toContain('My Title');
    expect(seen).toContain('My Body');
  });

  it('throws when gh exits nonzero, naming what gh reported', async () => {
    const gh: GhRunner = async () => ({ stdout: '', exitCode: 1, stderr: 'auth error' });
    await expect(openPr(gh, { cwd: '/wt', title: 'T', body: 'b' })).rejects.toThrow(/auth error/);
  });

  it('still says something useful when gh fails silently', async () => {
    const gh: GhRunner = async () => ({ stdout: '', exitCode: 3, stderr: '' });
    await expect(openPr(gh, { cwd: '/wt', title: 'T', body: 'b' })).rejects.toThrow(/exit 3/);
  });
});
