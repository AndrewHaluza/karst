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
  /** A ratchet-ledger change that only removes entries — counts as approved without the user. */
  autoApproved: boolean;
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

/** The merge-base of the ticket's base and HEAD — the same point `git diff` compares against. */
export async function resolveMergeBase(
  git: GitRunner,
  cwd: string,
  baseRef: string,
): Promise<string> {
  const spec = await resolveBaseSpec(git, cwd, baseRef);
  const mb = await git(['merge-base', spec, 'HEAD'], cwd);
  const mergeBase = mb.stdout.trim();
  if (mb.exitCode !== 0 || mergeBase === '') {
    throw new Error(
      `baseline review: no merge-base between ${spec} and HEAD in ${cwd}: ${mb.stderr.trim()}`,
    );
  }
  return mergeBase;
}

function parseJsonArray(text: string): unknown[] | null {
  try {
    const value: unknown = JSON.parse(text);
    return Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * A ratchet-ledger change that can only TIGHTEN needs no review: a deleted
 * `.json` file, or a `.json` array whose entries are all already in the base's.
 * Everything else — images included — is the user's to approve.
 */
async function isLedgerShrink(
  deps: BaselineDetectDeps,
  input: BaselineRepoInput,
  mergeBase: string,
  path: string,
  status: BaselineStatus,
  newContent: Buffer | null,
): Promise<boolean> {
  if (!path.toLowerCase().endsWith('.json')) return false;
  if (status === 'deleted') return true;
  if (status !== 'modified' || newContent === null) return false;
  const old = await deps.git(['show', `${mergeBase}:${path}`], input.cwd);
  if (old.exitCode !== 0) return false;
  const before = parseJsonArray(old.stdout);
  const after = parseJsonArray(newContent.toString('utf8'));
  if (before === null || after === null) return false;
  const kept = new Set(before.map((item) => JSON.stringify(item)));
  return after.every((item) => kept.has(JSON.stringify(item)));
}

async function detectInRepo(
  deps: BaselineDetectDeps,
  input: BaselineRepoInput,
  globs: readonly string[],
): Promise<BaselineEntry[]> {
  const { git } = deps;
  const read = deps.readFile ?? ((abs: string) => readFile(abs));
  const mergeBase = await resolveMergeBase(git, input.cwd, input.baseRef);
  const specs = toPathspecs(globs);
  // The WORKING TREE, not HEAD: at UAT nothing is committed yet (ship makes the
  // commit), so a baseline the agent re-recorded is an uncommitted change.
  const diff = await git(
    ['diff', '--no-renames', '--name-status', '-z', mergeBase, '--', ...specs],
    input.cwd,
  );
  if (diff.exitCode !== 0) {
    throw new Error(`baseline review: git diff failed in ${input.cwd}: ${diff.stderr.trim()}`);
  }
  // Untracked files are invisible to `git diff`; `--exclude-standard` keeps
  // gitignored artifacts (reports, shards) out.
  const untracked = await git(
    ['ls-files', '--others', '--exclude-standard', '-z', '--', ...specs],
    input.cwd,
  );
  if (untracked.exitCode !== 0) {
    throw new Error(`baseline review: git ls-files failed in ${input.cwd}: ${untracked.stderr.trim()}`);
  }
  const changes = [
    ...parseNameStatus(diff.stdout).flatMap(({ letter, path }) => {
      const status = STATUS_BY_LETTER[letter];
      return status === undefined ? [] : [{ path, status }];
    }),
    ...untracked.stdout
      .split('\0')
      .filter((path) => path !== '')
      .map((path) => ({ path, status: 'added' as const })),
  ];
  const entries: BaselineEntry[] = [];
  for (const { path, status } of changes) {
    const content = status === 'deleted' ? null : await read(join(input.cwd, path));
    entries.push({
      repo: input.repo,
      cwd: input.cwd,
      path,
      status,
      newSha256: content === null ? DELETED_SHA : createHash('sha256').update(content).digest('hex'),
      mergeBase,
      autoApproved: await isLedgerShrink(deps, input, mergeBase, path, status, content),
    });
  }
  return entries;
}

/**
 * Every file the ticket changed under `globs` in its working tree, per repo, in
 * a stable order. Empty `globs` is the feature being off: nothing is read or
 * spawned. THROWS when a repo's merge-base or diff cannot be answered — the
 * caller parks (the question could not be asked); it never reads that as
 * "nothing changed".
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
  if (entry.autoApproved) return { kind: 'approved' };
  const decision = latest.get(baselineKey(entry.repo, entry.path));
  if (!decision || decision.sha256 !== entry.newSha256) return { kind: 'pending' };
  return decision.decision === 'approved'
    ? { kind: 'approved' }
    : { kind: 'rejected', reason: decision.reason ?? '' };
}

/** Entries still needing the user (pending or rejected) — what blocks UAT. */
export function unapprovedBaselines(
  entries: readonly BaselineEntry[],
  latest: ReadonlyMap<string, BaselineDecision>,
): BaselineEntry[] {
  return entries.filter((entry) => baselineState(entry, latest).kind !== 'approved');
}
