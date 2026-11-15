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
 * sha256 over, per repo, `git diff --raw --no-abbrev -z --no-renames <merge-base>`
 * (object ids, so the input grows with the number of files, not their bytes),
 * the content hash of each changed file the diff reports with the null id (an
 * unstaged edit), and the sorted (path, sha) of untracked files.
 * `--exclude-standard` keeps gitignored artifacts (reports, shards, result
 * files) out, so two unchanged runs agree.
 */

/** A raw diff beyond this is not fingerprinted (the skip is simply not taken). */
const RAW_DIFF_MAX_BYTES = 16 * 1024 * 1024;

const NULL_ID = /^0+$/;

const defaultGitBytes: GitBytesRunner = (args, cwd, options) =>
  runGitBytes(args, cwd, GIT_TIMEOUT_MS, RAW_DIFF_MAX_BYTES, GIT_TERMINATION_GRACE_MS, options?.signal);

export interface FingerprintDeps {
  git: GitRunner;
  gitBytes?: GitBytesRunner;
  readFile?: (absPath: string) => Promise<Buffer>;
  /** Called with the reason when the fingerprint is `null`. */
  debug?: (message: string) => void;
}

const sha256 = (data: Buffer | string): string => createHash('sha256').update(data).digest('hex');

/** Paths of `--raw -z` entries whose working-tree side has the null id and still exist. */
function nullIdPaths(raw: string): string[] {
  const tokens = raw.split('\0');
  const paths: string[] = [];
  for (let i = 0; i + 1 < tokens.length; i += 2) {
    const fields = (tokens[i] ?? '').split(' ');
    const newId = fields[3] ?? '';
    const status = fields[4] ?? '';
    if (NULL_ID.test(newId) && !status.startsWith('D')) paths.push(tokens[i + 1] ?? '');
  }
  return paths;
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
      const diff = await gitBytes(['diff', '--raw', '--no-abbrev', '--no-renames', '-z', mergeBase], repo.cwd);
      if (diff.exitCode !== 0 || diff.stdoutTruncated) {
        deps.debug?.(
          `gate fingerprint n/a for ${repo.repo}: ` +
            (diff.stdoutTruncated ? `raw diff over ${RAW_DIFF_MAX_BYTES} B` : `git diff exit ${diff.exitCode}`),
        );
        return null;
      }
      const listed = await deps.git(['ls-files', '--others', '--exclude-standard', '-z'], repo.cwd);
      if (listed.exitCode !== 0) {
        deps.debug?.(`gate fingerprint n/a for ${repo.repo}: git ls-files exit ${listed.exitCode}`);
        return null;
      }
      hash.update(`repo:${repo.repo}\0`).update(diff.stdout).update('\0unstaged\0');
      for (const path of nullIdPaths(diff.stdout.toString('utf8')).sort()) {
        hash.update(`${path}\0${sha256(await read(join(repo.cwd, path)))}\n`);
      }
      hash.update('\0untracked\0');
      for (const path of listed.stdout.split('\0').filter((p) => p !== '').sort()) {
        hash.update(`${path}\0${sha256(await read(join(repo.cwd, path)))}\n`);
      }
    }
  } catch (err) {
    deps.debug?.(`gate fingerprint n/a: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
  return hash.digest('hex');
}
