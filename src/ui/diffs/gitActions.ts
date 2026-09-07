import type { GitRunner } from '../../integrations/git.js';
import type { FileChangeStatus } from './gitParsers.js';

/**
 * Pure, testable helpers for git write operations (discard, unstage).
 * All operations go through the injected `GitRunner` — async only, never
 * `spawnSync` — so the extension host event loop is never blocked.
 */

export interface GitActionResult {
  ok: boolean;
  error?: string;
}

async function runGit(
  git: GitRunner,
  args: string[],
  cwd: string,
): Promise<GitActionResult> {
  try {
    const result = await git(args, cwd);
    if (result.exitCode !== 0) {
      const reason = result.stderr.trim() || result.stdout.trim() || `git exit ${result.exitCode}`;
      return { ok: false, error: reason };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Discard working-tree changes for a file.
 *
 * - Untracked files: `git clean -f -- <path>`
 * - Tracked files: `git restore -- <path>`
 */
export async function discardChanges(
  git: GitRunner,
  cwd: string,
  path: string,
  status: FileChangeStatus,
): Promise<GitActionResult> {
  if (status === 'added') {
    return runGit(git, ['clean', '-f', '--', path], cwd);
  }
  return runGit(git, ['restore', '--', path], cwd);
}

/**
 * Unstage a file from the index.
 *
 * `git restore --staged -- <path>`
 */
export async function unstageFile(
  git: GitRunner,
  cwd: string,
  path: string,
): Promise<GitActionResult> {
  return runGit(git, ['restore', '--staged', '--', path], cwd);
}
