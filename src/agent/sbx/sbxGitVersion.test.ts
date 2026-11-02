import { describe, expect, it } from 'vitest';
import { checkSandboxGit, MIN_SANDBOX_GIT } from './sbxGitVersion.js';

describe('checkSandboxGit', () => {
  it('pins the minimum at 2.42 (git worktree add --relative-paths)', () => {
    expect(MIN_SANDBOX_GIT).toBe('2.42');
  });
  it('blocks 2.39.5 with the rebuild reason', () => {
    expect(checkSandboxGit('git version 2.39.5\n')).toEqual({
      ok: false,
      reason: 'sandbox git 2.39.5 is older than 2.42; rebuild the sandbox image',
    });
  });
  it('blocks a lower minor even when the major digit compares higher as text', () => {
    expect(checkSandboxGit('git version 2.9.0').ok).toBe(false);
  });
  it('passes 2.42.0 and newer', () => {
    expect(checkSandboxGit('git version 2.42.0')).toEqual({ ok: true });
    expect(checkSandboxGit('git version 2.54.1 (Apple Git-1)')).toEqual({ ok: true });
    expect(checkSandboxGit('git version 3.0.0')).toEqual({ ok: true });
  });
  it('blocks unparseable output and quotes it raw', () => {
    expect(checkSandboxGit('bash: git: not found\n')).toEqual({
      ok: false,
      reason: 'sandbox git version unreadable (bash: git: not found); rebuild the sandbox image',
    });
  });
});
