import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { GitRunner } from '../../integrations/git.js';
import {
  baselineKey,
  type BaselineDecision,
} from '../../store/baselineDecisions.js';

/**
 * Baseline-review detection (@arch:BASELINE-REVIEW). Finds the files a ticket
 * changed under `uat.baselineReview.paths` and says which of them the USER has
 * approved. Git and the filesystem are injected: no store, no `vscode`.
 */

export type BaselineStatus = 'added' | 'modified' | 'deleted';

/** The `newSha256` of a deleted file — there is nothing left to hash. */
export const DELETED_SHA = 'deleted';

export interface BaselineEntry {
  /** The worktree's `repo` key (the manifest repoPath) — the decision key. */
  repo: string;
  /** The worktree directory the entry was found in. */
  cwd: string;
  /** Repo-relative, forward-slash path. */
  path: string;
  status: BaselineStatus;
  /** sha256 of the file at HEAD, or `DELETED_SHA`. */
  newSha256: string;
  /** The merge-base commit the old content is read from (`git show <sha>:<path>`). */
  mergeBase: string;
}

export interface BaselineRepoInput {
  repo: string;
  cwd: string;
  /** The ticket's resolved base branch NAME (`resolveTicketBaseRef`), no `origin/`. */
  baseRef: string;
}

export interface BaselineDetectDeps {
  git: GitRunner;
  /** Defaults to reading the file from disk. */
  readFile?: (absPath: string) => Promise<Buffer>;
}

const STATUS_BY_LETTER: Readonly<Record<string, BaselineStatus>> = {
  A: 'added',
  M: 'modified',
  T: 'modified',
  D: 'deleted',
};

/** `:(glob)` pathspecs give `**` its recursive meaning and stay repo-relative. */
export function toPathspecs(globs: readonly string[]): string[] {
  return globs.map((glob) => `:(glob)${glob}`);
}

/** The base to diff against: the remote-tracking ref when present, else the local branch. */
async function resolveBaseSpec(git: GitRunner, cwd: string, baseRef: string): Promise<string> {
  const remote = await git(['rev-parse', '--verify', `origin/${baseRef}^{commit}`], cwd);
  return remote.exitCode === 0 ? `origin/${baseRef}` : baseRef;
}

/** Parse `git diff --name-status -z` output into (letter, path) pairs. */
function parseNameStatus(stdout: string): Array<{ letter: string; path: string }> {
  const parts = stdout.split('\0').filter((part) => part !== '');
  const out: Array<{ letter: string; path: string }> = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    out.push({ letter: parts[i]!.charAt(0), path: parts[i + 1]! });
  }
  return out;
}

async function detectInRepo(
  deps: BaselineDetectDeps,
  input: BaselineRepoInput,
  globs: readonly string[],
): Promise<BaselineEntry[]> {
  const { git } = deps;
  const read = deps.readFile ?? ((abs: string) => readFile(abs));
  const spec = await resolveBaseSpec(git, input.cwd, input.baseRef);
  const mb = await git(['merge-base', spec, 'HEAD'], input.cwd);
  const mergeBase = mb.stdout.trim();
  if (mb.exitCode !== 0 || mergeBase === '') {
    throw new Error(
      `baseline review: no merge-base between ${spec} and HEAD in ${input.cwd}: ${mb.stderr.trim()}`,
    );
  }
  const diff = await git(
    ['diff', '--no-renames', '--name-status', '-z', mergeBase, 'HEAD', '--', ...toPathspecs(globs)],
    input.cwd,
  );
  if (diff.exitCode !== 0) {
    throw new Error(`baseline review: git diff failed in ${input.cwd}: ${diff.stderr.trim()}`);
  }
  const entries: BaselineEntry[] = [];
  for (const { letter, path } of parseNameStatus(diff.stdout)) {
    const status = STATUS_BY_LETTER[letter];
    if (status === undefined) continue;
    const newSha256 =
      status === 'deleted'
        ? DELETED_SHA
        : createHash('sha256').update(await read(join(input.cwd, path))).digest('hex');
    entries.push({ repo: input.repo, cwd: input.cwd, path, status, newSha256, mergeBase });
  }
  return entries;
}

/**
 * Every file the ticket changed under `globs`, per repo, in a stable order.
 * Empty `globs` is the feature being off: nothing is read or spawned.
 * THROWS when a repo's merge-base or diff cannot be answered — the caller parks
 * (the question could not be asked); it never reads that as "nothing changed".
 */
export async function detectBaselineChanges(
  deps: BaselineDetectDeps,
  repos: readonly BaselineRepoInput[],
  globs: readonly string[],
): Promise<BaselineEntry[]> {
  if (globs.length === 0) return [];
  const all: BaselineEntry[] = [];
  for (const repo of repos) all.push(...(await detectInRepo(deps, repo, globs)));
  return all.sort((a, b) => a.repo.localeCompare(b.repo) || a.path.localeCompare(b.path));
}

export type BaselineDecisionState =
  | { kind: 'pending' }
  | { kind: 'approved' }
  | { kind: 'rejected'; reason: string };

/**
 * The state of one entry for THIS run. A decision binds to the sha it was made
 * on: an agent re-recording the file changes the sha, the old row stops
 * matching, and the entry is pending again.
 */
export function baselineState(
  entry: BaselineEntry,
  latest: ReadonlyMap<string, BaselineDecision>,
): BaselineDecisionState {
  const decision = latest.get(baselineKey(entry.repo, entry.path));
  if (!decision || decision.sha256 !== entry.newSha256) return { kind: 'pending' };
  return decision.decision === 'approved'
    ? { kind: 'approved' }
    : { kind: 'rejected', reason: decision.reason ?? '' };
}

/** Entries the user has not approved (pending or rejected) — what blocks UAT. */
export function unapprovedBaselines(
  entries: readonly BaselineEntry[],
  latest: ReadonlyMap<string, BaselineDecision>,
): BaselineEntry[] {
  return entries.filter((entry) => baselineState(entry, latest).kind !== 'approved');
}
