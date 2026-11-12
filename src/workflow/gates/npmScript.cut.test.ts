import { describe, expect, it } from 'vitest';
import type { GitRunner } from '../../integrations/git.js';
import { cutDefinesScript } from './npmScript.js';

const ok = (stdout: string) => ({ exitCode: 0, stdout, stderr: '' });
const fail = { exitCode: 128, stdout: '', stderr: 'fatal' };

function fakeGit(map: Record<string, ReturnType<typeof ok> | typeof fail>): { git: GitRunner; calls: string[][] } {
  const calls: string[][] = [];
  const git: GitRunner = async (args) => {
    calls.push([...args]);
    return map[args[0]!] ?? fail;
  };
  return { git, calls };
}

describe('cutDefinesScript', () => {
  it('reads package.json at the merge-base of HEAD and the base ref', async () => {
    const { git, calls } = fakeGit({ 'merge-base': ok('abc123\n'), show: ok('{"scripts":{"lint:layers":"x"}}') });
    expect(await cutDefinesScript(git, '/wt', 'develop', 'lint:layers')).toBe(true);
    expect(calls[0]).toEqual(['merge-base', 'HEAD', 'origin/develop']);
    expect(calls[1]).toEqual(['show', 'abc123:./package.json']);
  });

  it('falls back to the local base branch when origin/<base> is unknown', async () => {
    const calls: string[][] = [];
    const git: GitRunner = async (args) => {
      calls.push([...args]);
      if (args[0] === 'merge-base') return args[2] === 'origin/develop' ? fail : ok('abc123');
      return ok('{"scripts":{"s":"x"}}');
    };
    expect(await cutDefinesScript(git, '/wt', 'develop', 's')).toBe(true);
    expect(calls[1]).toEqual(['merge-base', 'HEAD', 'develop']);
  });

  it('says false when the cut commit has no such script', async () => {
    const { git } = fakeGit({ 'merge-base': ok('abc123'), show: ok('{"scripts":{"test":"x"}}') });
    expect(await cutDefinesScript(git, '/wt', 'develop', 'lint:layers')).toBe(false);
  });

  it('says null when merge-base fails, so the caller falls back to the worktree', async () => {
    const { git } = fakeGit({});
    expect(await cutDefinesScript(git, '/wt', 'develop', 'lint:layers')).toBeNull();
  });

  it('says null when package.json cannot be shown or parsed', async () => {
    expect(await cutDefinesScript(fakeGit({ 'merge-base': ok('abc') }).git, '/wt', 'develop', 's')).toBeNull();
    expect(await cutDefinesScript(fakeGit({ 'merge-base': ok('abc'), show: ok('{bad') }).git, '/wt', 'develop', 's')).toBeNull();
  });
});
