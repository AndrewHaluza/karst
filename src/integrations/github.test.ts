import { describe, it, expect } from 'vitest';
import { openPr, type GhRunner } from './github.js';

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

  it('throws when gh exits nonzero', async () => {
    const gh: GhRunner = async () => ({ stdout: '', exitCode: 1, stderr: 'auth error' });
    await expect(openPr(gh, { cwd: '/wt', title: 'T', body: 'b' })).rejects.toThrow();
  });
});
