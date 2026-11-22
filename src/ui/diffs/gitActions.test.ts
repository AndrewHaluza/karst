import { describe, it, expect, vi } from 'vitest';
import type { GitRunner, GitResult } from '../../integrations/git.js';
import { discardChanges, discardConfirmText, unstageFile } from './gitActions.js';

function makeGitRunner(exitCode = 0, stdout = '', stderr = ''): GitRunner {
  return vi.fn(async (): Promise<GitResult> => ({
    stdout,
    stderr,
    exitCode,
  }));
}

describe('discardChanges', () => {
  it('calls git clean for untracked (added) files', async () => {
    const git = makeGitRunner();
    const result = await discardChanges(git, '/repo', 'new-file.ts', 'added');

    expect(result.ok).toBe(true);
    expect(git).toHaveBeenCalledWith(['clean', '-f', '--', 'new-file.ts'], '/repo');
  });

  it('calls git restore for tracked files', async () => {
    const git = makeGitRunner();
    const result = await discardChanges(git, '/repo', 'modified.ts', 'modified');

    expect(result.ok).toBe(true);
    expect(git).toHaveBeenCalledWith(['restore', '--', 'modified.ts'], '/repo');
  });

  it('calls git restore for deleted files', async () => {
    const git = makeGitRunner();
    const result = await discardChanges(git, '/repo', 'deleted.ts', 'deleted');

    expect(result.ok).toBe(true);
    expect(git).toHaveBeenCalledWith(['restore', '--', 'deleted.ts'], '/repo');
  });

  it('calls git restore for renamed files', async () => {
    const git = makeGitRunner();
    const result = await discardChanges(git, '/repo', 'new-name.ts', 'renamed');

    expect(result.ok).toBe(true);
    expect(git).toHaveBeenCalledWith(['restore', '--', 'new-name.ts'], '/repo');
  });

  it('returns error on git failure', async () => {
    const git = makeGitRunner(1, '', 'pathspec did not match');
    const result = await discardChanges(git, '/repo', 'file.ts', 'modified');

    expect(result.ok).toBe(false);
    expect(result.error).toBe('pathspec did not match');
  });

  it('returns error on exception', async () => {
    const git = vi.fn(async () => { throw new Error('spawn failed'); });
    const result = await discardChanges(git, '/repo', 'file.ts', 'modified');

    expect(result.ok).toBe(false);
    expect(result.error).toBe('spawn failed');
  });
});

/**
 * DF-1 (decision Q7): ONE confirmation text for the panel and the SCM tree. The
 * wording differs from the old mock on purpose — an untracked file is deleted,
 * not restored, so its message has to say so.
 */
describe('discardConfirmText', () => {
  it('says the new file is deleted for an added file (the git clean path)', () => {
    expect(discardConfirmText('src/new.ts', 'added')).toEqual({
      message: 'Delete the new file src/new.ts? This cannot be undone.',
      action: 'Delete file',
    });
  });

  it('says the changes are discarded for a tracked file (the git restore path)', () => {
    expect(discardConfirmText('src/app.ts', 'modified')).toEqual({
      message: 'Discard the changes to src/app.ts? This cannot be undone.',
      action: 'Discard changes',
    });
  });

  it('uses the discard text for deleted and renamed files, which git restores', () => {
    expect(discardConfirmText('src/gone.ts', 'deleted').action).toBe('Discard changes');
    expect(discardConfirmText('src/new-name.ts', 'renamed').action).toBe('Discard changes');
  });
});

describe('unstageFile', () => {
  it('calls git restore --staged', async () => {
    const git = makeGitRunner();
    const result = await unstageFile(git, '/repo', 'staged.ts');

    expect(result.ok).toBe(true);
    expect(git).toHaveBeenCalledWith(['restore', '--staged', '--', 'staged.ts'], '/repo');
  });

  it('returns error on git failure', async () => {
    const git = makeGitRunner(1, '', 'not in the index');
    const result = await unstageFile(git, '/repo', 'file.ts');

    expect(result.ok).toBe(false);
    expect(result.error).toBe('not in the index');
  });

  it('returns error on exception', async () => {
    const git = vi.fn(async () => { throw new Error('network error'); });
    const result = await unstageFile(git, '/repo', 'file.ts');

    expect(result.ok).toBe(false);
    expect(result.error).toBe('network error');
  });
});
