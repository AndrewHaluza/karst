import type { Store } from '../../store/db.js';
import type { Manifest } from '../../manifest/types.js';
import {
  assertSubtaskParentReady,
  resolvePlannedBase,
  subtaskParentBranch,
  SubtaskParentNotStartedError,
} from '../baseRef.js';
import { createWorktree, type WorktreeRecord } from '../../runtime/worktree.js';
import { pullBaseRef } from '../../runtime/pullBase.js';
import { defaultGitRunner, type GitRunner } from '../../integrations/git.js';
import { getTicket } from '../../store/tickets.js';
import { ticketWorktreeNames } from '../../runtime/ticketBranch.js';
import { clearStageBlock, parkGateStage, stageBlock } from '../../store/stageBlocks.js';

/**
 * Scope stage (§T4.2, §17.1). The user selects which repos go *hot* for a
 * ticket. Two responsibilities, split so the pure part stays testable:
 *
 *  - `scopeTicket` — pure preview: validate the hot set against the manifest and
 *    surface warnings. A hot service that runs DB migrations is flagged "not
 *    first-class under shared-DB" (MVP shares one DB; a migration ticket can
 *    reshape it under the others). The signal is the author-declared
 *    `hasMigrations` manifest field — deterministic, not a filesystem heuristic.
 *  - `confirmScope` — the side-effecting confirm: create worktrees *lazily*, one
 *    per hot repo, off the baseline branch. Nothing is created until confirm.
 *
 * A sub-task (design NDL-70 §4) cuts from the parent's branch instead: the
 * precondition is that the parent already has a worktree in every repo the
 * sub-task touches, and the base pull is skipped because the start point is the
 * parent's LOCAL head, never `origin/<parentBranch>`.
 */

export interface ScopeResult {
  warnings: string[];
}

/** Validate the hot set and collect warnings. Pure — no store, no git. */
export function scopeTicket(manifest: Manifest, hot: string[]): ScopeResult {
  const warnings: string[] = [];
  for (const name of hot) {
    const repo = manifest.repositories[name];
    if (!repo) {
      throw new Error(`unknown repository '${name}' in hot set (not in manifest)`);
    }
    // Runnability is deliberately NOT checked: a repository with no service is a
    // valid scope member (it gets a worktree, it just never starts).
    if (repo.hasMigrations) {
      warnings.push(
        `Repository '${name}' carries migrations — not first-class under shared-DB. ` +
          `Its schema changes affect every other ticket sharing the database; review before spinning.`,
      );
    }
  }
  return { warnings };
}

export interface ConfirmScopeOptions {
  /**
   * Refresh each repository's baseline branch from the remote before branching
   * (§ pull switch). ON by default — a worktree cut from a stale local base
   * starts the ticket behind the team — but the caller's explicit choice is
   * honored, so `false` means "branch from what this clone already has".
   */
  pullBase?: boolean;
  /** Injected git runner (real: `defaultGitRunner`); tests supply a fake. */
  git?: GitRunner;
  /**
   * A pull that did not happen, per repository. A REPORT, not an error: the
   * worktree is created either way, so the host surfaces the reason rather than
   * turning an unreachable remote into a failed ticket creation.
   */
  onPullFailed?: (repoPath: string, baseRef: string, reason: string) => void;
  /**
   * Verbose decision-point logging (§ debug logging), prefixed `[runtime]`.
   * Absent → no debug lines; the host binds it to `Logger.debug` (a no-op
   * unless the manifest's `debug` flag is on).
   */
  debug?: (message: string) => void;
}

/**
 * Confirm the scope: create one worktree per hot repository off `baselineBranch`.
 * The slug ties the branch/worktree to the ticket. Deduplicates repo paths so a
 * ticket scoping two repository entries at one repoPath (a monorepo with two
 * runnable processes) makes a single worktree — and so it pulls once per
 * repoPath, not once per manifest entry.
 *
 * Async because the pull talks to a remote: this runs in the extension host, so
 * the fetch goes through the async `GitRunner`, never a sync spawn.
 */
export async function confirmScope(
  store: Store,
  manifest: Manifest,
  ticketId: number,
  hot: string[],
  opts: ConfirmScopeOptions = {},
): Promise<WorktreeRecord[]> {
  const pullBase = opts.pullBase !== false;
  const git = opts.git ?? defaultGitRunner;
  const seen = new Set<string>();
  const records: WorktreeRecord[] = [];
  const ticket = getTicket(store, ticketId);
  const { slug, branch } = ticketWorktreeNames(ticket, manifest);
  opts.debug?.(
    `[runtime] scope ticket ${ticketId}: creating worktrees for ${hot.length} hot repo(s) ` +
      `off '${branch}' (pull base ${pullBase ? 'on' : 'off'})`,
  );

  // Sub-task precondition (design NDL-70 §4): the parent must already have a
  // worktree in every repo the sub-task touches — the sub-task's branch stacks
  // on the parent's branch. Park `scope` with the reason (nothing is cut) rather
  // than let `createWorktree` fail on a missing base or, worse, silently root the
  // sub-task on the manifest default. The parent is never auto-spun.
  try {
    assertSubtaskParentReady(store, ticket, manifest, hot);
  } catch (err) {
    if (err instanceof SubtaskParentNotStartedError) {
      parkGateStage(store, {
        ticketId,
        stageKey: 'scope',
        kind: 'nothing-to-run',
        reason: err.message,
        runAt: new Date().toISOString(),
        gates: [],
      });
      opts.debug?.(`[runtime] scope ticket ${ticketId}: ${err.message} — parked scope`);
    }
    throw err;
  }
  // The precondition holds, so a block a previous parking left on `scope` is
  // stale: clear it, or a sub-task that is now startable keeps a scope blocker.
  if (stageBlock(store, ticketId, 'scope')) clearStageBlock(store, ticketId, 'scope');

  for (const name of hot) {
    const repo = manifest.repositories[name];
    if (!repo) {
      opts.debug?.(`[runtime] scope ticket ${ticketId}: unknown repo '${name}' in hot set`);
      throw new Error(`unknown repository '${name}' in hot set (not in manifest)`);
    }
    if (seen.has(repo.repoPath)) {
      opts.debug?.(
        `[runtime] scope ticket ${ticketId}: repoPath '${repo.repoPath}' already seen — deduping`,
      );
      continue;
    }
    seen.add(repo.repoPath);

    const planned = resolvePlannedBase(
      ticket,
      manifest,
      name,
      subtaskParentBranch(store, ticket, manifest, name),
    );
    const baseRef = planned.baseRef;
    let startPoint = baseRef;
    if (planned.skipPull) {
      // The sub-task base is the parent's LOCAL branch head. Pulling it would
      // move the start point to `origin/<parentBranch>`, which may be BEHIND the
      // parent's newest unpushed commits — exactly the work the sub-task stacks on.
      opts.debug?.(
        `[runtime] scope ticket ${ticketId}: '${repo.repoPath}' is a sub-task stack on parent ` +
          `branch '${baseRef}' — skipping pull (start point is the parent's local head)`,
      );
    } else if (pullBase) {
      const pulled = await pullBaseRef(git, repo.repoPath, baseRef);
      startPoint = pulled.startPoint;
      if (!pulled.refreshed && pulled.reason) {
        opts.debug?.(
          `[runtime] scope ticket ${ticketId}: pull of '${baseRef}' in ` +
            `'${repo.repoPath}' did not refresh (${pulled.reason})`,
        );
        opts.onPullFailed?.(repo.repoPath, baseRef, pulled.reason);
      }
    }

    opts.debug?.(
      `[runtime] scope ticket ${ticketId}: creating worktree for '${repo.repoPath}' ` +
        `from '${baseRef}'@${startPoint}`,
    );
    records.push(
      createWorktree(store, {
        ticketId,
        repoPath: repo.repoPath,
        slug,
        branch,
        baseRef,
        startPoint,
      }),
    );
  }

  opts.debug?.(
    `[runtime] scope ticket ${ticketId}: created ${records.length} worktree(s) ` +
      `(${records.map((r) => r.repoPath).join(', ') || 'none'})`,
  );
  return records;
}
