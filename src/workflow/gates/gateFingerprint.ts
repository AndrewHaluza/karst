import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  GIT_TERMINATION_GRACE_MS,
  GIT_TIMEOUT_MS,
  runGitBytes,
  type GitBytesRunner,
  type GitRunner,
} from '../../integrations/git.js';
import { resolveMergeBase, type BaselineRepoInput } from './baselineReview.js';

/**
 * A fingerprint of the code UAT's gates run against (@arch:BASELINE-REVIEW):
 * sha256 over, per repo, `git diff --binary <merge-base>` plus the sorted
 * (path, sha) of untracked files. `--exclude-standard` keeps gitignored
 * artifacts (reports, shards, result files) out, so two unchanged runs agree.
 */

/** A diff beyond this is not fingerprinted (the skip is simply not taken). */
const DIFF_MAX_BYTES = 64 * 1024 * 1024;

const defaultGitBytes: GitBytesRunner = (args, cwd, options) =>
  runGitBytes(args, cwd, GIT_TIMEOUT_MS, DIFF_MAX_BYTES, GIT_TERMINATION_GRACE_MS, options?.signal);

export interface FingerprintDeps {
  git: GitRunner;
  gitBytes?: GitBytesRunner;
  readFile?: (absPath: string) => Promise<Buffer>;
}

/**
 * `null` when it cannot be computed honestly (git failed, the diff was
 * truncated): the caller then runs the gates in full and records nothing.
 */
export async function gateFingerprint(
  deps: FingerprintDeps,
  repos: readonly BaselineRepoInput[],
): Promise<string | null> {
  const gitBytes = deps.gitBytes ?? defaultGitBytes;
  const read = deps.readFile ?? ((abs: string) => readFile(abs));
  const hash = createHash('sha256');
  try {
    for (const repo of [...repos].sort((a, b) => a.repo.localeCompare(b.repo))) {
      const mergeBase = await resolveMergeBase(deps.git, repo.cwd, repo.baseRef);
      const diff = await gitBytes(['diff', '--binary', mergeBase], repo.cwd);
      if (diff.exitCode !== 0 || diff.stdoutTruncated) return null;
      const listed = await deps.git(['ls-files', '--others', '--exclude-standard', '-z'], repo.cwd);
      if (listed.exitCode !== 0) return null;
      hash.update(`repo:${repo.repo}\0`).update(diff.stdout).update('\0untracked\0');
      for (const path of listed.stdout.split('\0').filter((p) => p !== '').sort()) {
        const sha = createHash('sha256').update(await read(join(repo.cwd, path))).digest('hex');
        hash.update(`${path}\0${sha}\n`);
      }
    }
  } catch {
    return null;
  }
  return hash.digest('hex');
}
