import type { Store } from '../store/db.js';
import type { Manifest } from '../manifest/types.js';
import { resolveBaselineBranch, resolveBaselineBranchForPath } from '../manifest/baselineBranch.js';
import { findTicketById, getTicket } from '../store/tickets.js';

/**
 * The ONE place a ticket's base branch is decided.
 *
 * Order is load-bearing:
 *   1. `worktrees.base_ref` — the branch was ALREADY cut from it, so it is the
 *      only answer that matches what git actually did. Changing the manifest
 *      later must not silently retarget an existing PR.
 *   2. the ticket's own pre-spin override (`tickets.base_refs`, keyed by
 *      manifest repository NAME).
 *   3. the sub-task rule (design NDL-70 §4): a ticket with `subtask_parent_id`
 *      whose parent is still open stacks on the parent's branch for that repo.
 *   4. the manifest default (`repositories.<name>.baselineBranch ?? baselineBranch`).
 *
 * Every value here is a PLAIN branch name; consumers prepend `origin/`.
 */

/** The slice of a ticket the base resolver reads. */
export interface PlannedBaseTicket {
  /** Pre-spin overrides, keyed by manifest repository NAME. */
  baseRefs?: Record<string, string>;
  /** Set when the ticket is PART OF an open parent (design NDL-70 §3). */
  subtaskParentId?: number | null;
}

function nonBlank(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? '';
  return trimmed === '' ? null : trimmed;
}

/** Where a planned base came from — callers branch on this for the pull switch. */
export type PlannedBaseSource = 'override' | 'subtask-parent' | 'manifest';

export interface PlannedBase {
  /** The plain branch NAME the worktree is cut from. */
  baseRef: string;
  source: PlannedBaseSource;
  /**
   * True only for the sub-task rule. The start point is the parent's LOCAL
   * branch head — never `origin/<parentBranch>` — because the parent's newest
   * commits may not be pushed yet. Consumers MUST skip the base pull.
   */
  skipPull: boolean;
}

/**
 * Apply the resolver order to one repository NAME. `parentBranch` is the
 * already-resolved parent branch for that repo's repoPath (or null when the
 * sub-task rule does not apply — not a sub-task, parent done/archived/missing,
 * or an explicit override won). Pure: the store read lives in
 * `subtaskParentBranch` / `assertSubtaskParentReady` below.
 */
export function resolvePlannedBase(
  ticket: PlannedBaseTicket,
  manifest: Manifest,
  repoName: string,
  parentBranch?: string | null,
): PlannedBase {
  const override = nonBlank(ticket.baseRefs?.[repoName]);
  if (override) return { baseRef: override, source: 'override', skipPull: false };
  const parent = nonBlank(parentBranch ?? undefined);
  if (parent) return { baseRef: parent, source: 'subtask-parent', skipPull: true };
  const repository = manifest.repositories[repoName];
  return {
    baseRef: repository ? resolveBaselineBranch(manifest, repository) : manifest.baselineBranch,
    source: 'manifest',
    skipPull: false,
  };
}

export function resolvePlannedBaseRef(
  ticket: PlannedBaseTicket,
  manifest: Manifest,
  repoName: string,
  parentBranch?: string | null,
): string {
  return resolvePlannedBase(ticket, manifest, repoName, parentBranch).baseRef;
}

/**
 * The parent's branch for `repoName`'s repoPath when the sub-task rule applies,
 * else null. Null means "fall through to normal resolution": the ticket is not a
 * sub-task, the parent row is missing/archived, the parent is `done` (merged —
 * design §4), or the parent has no worktree in this repo. Uses the parent's
 * `worktrees.branch` row for the SAME `repoPath`, so a shared-repoPath monorepo
 * entry stacks on the parent's single worktree there.
 */
export function subtaskParentBranch(
  store: Store,
  ticket: PlannedBaseTicket,
  manifest: Manifest,
  repoName: string,
): string | null {
  const parentId = ticket.subtaskParentId;
  if (parentId == null) return null;
  const repository = manifest.repositories[repoName];
  if (!repository) return null;
  const parent = findTicketById(store, parentId);
  if (!parent || parent.archivedAt !== null || parent.stageCurrent === 'done') return null;
  const row = store.db
    .prepare('SELECT branch FROM worktrees WHERE ticket_id = ? AND repo = ? LIMIT 1')
    .get(parentId, repository.repoPath) as { branch: string | null } | undefined;
  return nonBlank(row?.branch ?? undefined);
}

/** A sub-task asked for a cut before its parent had a worktree to stack on. */
export class SubtaskParentNotStartedError extends Error {
  constructor(
    readonly parentKey: string,
    readonly repoName: string,
  ) {
    super(`parent ${parentKey} has no worktree in '${repoName}' yet — start the parent first`);
    this.name = 'SubtaskParentNotStartedError';
  }
}

/**
 * The cut precondition (design NDL-70 §4): a sub-task may only be cut once its
 * parent already has a worktree in every repo the sub-task touches, because the
 * sub-task's branch stacks on the parent's branch. There is intentionally no
 * auto-spin of the parent — spinning a ticket as a side effect of another
 * ticket's scope is a hidden mutation the driver avoids.
 *
 * Applies only while the parent rule applies: not a sub-task, parent
 * done/archived/missing, or a repo with its own explicit `base_refs` override
 * all fall through and need no parent worktree. Throws naming the first missing
 * repo; the caller parks `scope` with the reason.
 */
export function assertSubtaskParentReady(
  store: Store,
  ticket: PlannedBaseTicket,
  manifest: Manifest,
  repoNames: readonly string[],
): void {
  const parentId = ticket.subtaskParentId;
  if (parentId == null) return;
  const parent = findTicketById(store, parentId);
  if (!parent || parent.archivedAt !== null || parent.stageCurrent === 'done') return;
  const parentKey = parent.key ?? `#${parent.id}`;
  const seen = new Set<string>();
  for (const name of repoNames) {
    const repository = manifest.repositories[name];
    if (!repository) continue;
    if (seen.has(repository.repoPath)) continue;
    seen.add(repository.repoPath);
    // An explicit override owns this repo's base — the parent branch is not used,
    // so the parent needs no worktree here.
    if (nonBlank(ticket.baseRefs?.[name])) continue;
    const row = store.db
      .prepare('SELECT branch FROM worktrees WHERE ticket_id = ? AND repo = ? LIMIT 1')
      .get(parentId, repository.repoPath) as { branch: string | null } | undefined;
    if (!nonBlank(row?.branch ?? undefined)) {
      throw new SubtaskParentNotStartedError(parentKey, name);
    }
  }
}

/** `getTicket` throws on a missing row; a base-branch lookup must not. */
function ticketOrNull(store: Store, ticketId: number): { baseRefs?: Record<string, string> } | null {
  try {
    return getTicket(store, ticketId);
  } catch {
    return null;
  }
}

export function resolveTicketBaseRef(
  store: Store,
  ticketId: number,
  repoPath: string,
  manifest: Manifest,
): string {
  const row = store.db
    .prepare('SELECT base_ref FROM worktrees WHERE ticket_id = ? AND repo = ? LIMIT 1')
    .get(ticketId, repoPath) as { base_ref: string | null } | undefined;
  const stored = nonBlank(row?.base_ref ?? undefined);
  if (stored) return stored;

  // `getTicket` THROWS on a missing row, and this resolver runs on gate paths
  // where a ticket may legitimately not exist (a bare-cwd run, a fixture, a row
  // archived mid-run). Resolving a base branch is never the place to fail a
  // gate: no ticket simply means no override, and the manifest answers.
  const ticket = ticketOrNull(store, ticketId);
  if (ticket) {
    for (const [name, repository] of Object.entries(manifest.repositories)) {
      if (repository.repoPath !== repoPath) continue;
      const override = nonBlank(ticket.baseRefs?.[name]);
      if (override) return override;
    }
  }
  return resolveBaselineBranchForPath(manifest, repoPath);
}

/**
 * Manifest entries may share a `repoPath` — one deduped worktree, which cannot
 * have two branch points. The manifest enforces this for its own defaults
 * (`assertSharedRepoBaselineBranches`); a per-ticket override can break it the
 * same way, so it is checked before the override is stored.
 */
export function assertSharedRepoBaseOverrides(
  manifest: Manifest,
  baseRefs: Record<string, string>,
): void {
  const seen = new Map<string, { name: string; branch: string }>();
  for (const [name, repository] of Object.entries(manifest.repositories)) {
    const branch = resolvePlannedBaseRef({ baseRefs }, manifest, name);
    const prior = seen.get(repository.repoPath);
    if (prior && prior.branch !== branch) {
      throw new Error(
        `repositories "${prior.name}" and "${name}" share repoPath "${repository.repoPath}" ` +
          `but were given different base branches ("${prior.branch}" and "${branch}")`,
      );
    }
    seen.set(repository.repoPath, { name, branch });
  }
}
