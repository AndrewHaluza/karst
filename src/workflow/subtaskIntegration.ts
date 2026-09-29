import type { Store } from '../store/db.js';
import type { StageKey } from '../model/types.js';
import { getTicket } from '../store/tickets.js';
import { listWorktreesByTicket } from '../store/dashboard.js';
import { listLandedSubtasks, listLandedStackedSubtasks } from '../store/subtasks.js';
import { setStage } from '../store/stages.js';
import { nowIso } from '../model/time.js';
import { collapseDiagnostic } from '../model/diagnosticText.js';
import type { GitRunner } from '../integrations/git.js';
import { onSubtaskLanded, clearIntegrationParks } from './subtaskGate.js';

/**
 * Integrate a landed sub-task's work into its parent's local branch (NDL-75,
 * design §6).
 *
 * For each repo the parent has a branch worktree in, and only when at least one
 * landed sub-task stacked on that branch:
 * 1. Refuse on a dirty TRACKED tree — park `awaiting-subtask` naming the
 *    sub-task(s).
 * 2. Fetch `origin/<parentBranch>`.
 * 3. Skip if `origin/<parentBranch>` is already an ancestor of HEAD — a
 *    landed-child row never leaves, so a re-drive must not re-refuse. THIS
 *    CHECK ALSO RUNS WHEN THE FETCH FAILS: an unreachable remote must not park
 *    a parent whose merge the local remote-tracking ref already resolves.
 * 4. `git merge --ff-only origin/<parentBranch>`; on failure,
 *    `git merge --no-edit origin/<parentBranch>` (no rebase, shared history).
 * 5. A `MERGE_HEAD` state is a conflict: read the unmerged files from git
 *    state, `merge --abort`, and park `subtask-integration-conflict` naming the
 *    sub-task and files. A failed abort parks too — the tree is mid-merge and
 *    needs manual cleanup.
 *
 * Every silent branch (status/merge failure, or a fetch failure whose merge the
 * local ref cannot confirm is resolved) PARKS instead of advancing:
 * `onSubtaskLanded` must never release the parent's gate without the child's
 * work. The whole step runs only while the parent is idle — karst never mutates
 * a tree under a live agent — and every branch logs via the injected `debug`
 * with the `[driver]` prefix.
 *
 * The merge target is the FETCHED `origin/<parentBranch>`: a sub-task's ship
 * pushes its fork point onto the remote parent branch, so that is what actually
 * landed. The child's local branch is irrelevant (and may be gone).
 */
export interface IntegrateOutcome {
  /**
   * True when integration stopped by parking the parent. The caller must NOT
   * release the gate; the park stays for a human or the next seam.
   */
  parked: boolean;
  /**
   * True when the parent's agent was running, so integration was DEFERRED to
   * the parent's next seam — nothing was merged. A deferral is not a success:
   * the caller must not clear an integration park on the strength of it.
   */
  deferred: boolean;
}

/** A `[driver]` debug line keeps untrusted git prose to one bounded line. */
const DEBUG_MAX_CHARS = 500;
function brief(result: { stdout: string; stderr: string }): string {
  return collapseDiagnostic(result.stderr.trim() || result.stdout.trim(), DEBUG_MAX_CHARS) || 'no output';
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Park the parent's CURRENT stage with an integration block. The stage is read
 * fresh — integration awaited, then parks, so `stage_current` is the parent's
 * real resting place, never a value captured before a drive.
 */
function parkParent(
  store: Store,
  parentId: number,
  kind: 'awaiting-subtask' | 'subtask-integration-conflict',
  reason: string,
  debug?: (message: string) => void,
): IntegrateOutcome {
  const stage = getTicket(store, parentId).stageCurrent as StageKey | null;
  if (!stage) {
    debug?.(`[driver] ticket ${parentId}: no current stage — cannot park (${reason})`);
    return { parked: true, deferred: false };
  }
  debug?.(`[driver] ticket ${parentId}: parking '${stage}' — ${reason}`);
  setStage(store, parentId, stage, {
    blockedKind: kind,
    blockedReason: reason,
    blockedAt: nowIso(),
  });
  return { parked: true, deferred: false };
}

export async function integrateLandedSubtasks(
  store: Store,
  parentId: number,
  git: GitRunner,
  debug?: (message: string) => void,
): Promise<IntegrateOutcome> {
  const parent = getTicket(store, parentId);
  if (parent.agentState === 'running') {
    debug?.(`[driver] ticket ${parentId}: agent is running — deferring sub-task integration`);
    return { parked: false, deferred: true };
  }

  const worktrees = listWorktreesByTicket(store, parentId).filter((wt) => wt.branch);
  if (worktrees.length === 0) {
    debug?.(`[driver] ticket ${parentId}: parent has no branch worktree`);
    return { parked: false, deferred: false };
  }

  if (listLandedSubtasks(store, parentId).length === 0) {
    debug?.(`[driver] ticket ${parentId}: no landed sub-tasks to integrate`);
    return { parked: false, deferred: false };
  }

  for (const wt of worktrees) {
    const branch = wt.branch!;
    const children = listLandedStackedSubtasks(store, parentId, wt.repo, branch);
    if (children.length === 0) continue;
    const keys = children.map((c) => c.key).join(', ');
    const remote = `origin/${branch}`;

    debug?.(`[driver] ticket ${parentId}: integrating ${keys} into '${wt.repo}' (${branch})`);

    // FETCH FIRST. The dirty check below must gate only a merge that is truly
    // needed, and `origin/<branch>` is the thing we merge.
    const fetch = await git(['fetch', 'origin', branch], wt.path);

    // Already integrated? `origin/<branch>` being an ancestor of HEAD means the
    // child's work is in — the landed-child row stays FOREVER, so without this
    // every later call would re-run the dirty check and block ship's own commit
    // step (the parent tree is normally uncommitted at ship entry).
    //
    // Check this EVEN WHEN THE FETCH FAILED. A fetch can fail only because the
    // remote is unreachable; the local `origin/<branch>` remote-tracking ref may
    // already hold the child's work, and an unreachable remote must not park a
    // parent whose merge is already resolved. Only a fetch failure with a merge
    // that is genuinely unresolved (the ref is absent, or not an ancestor) parks.
    const ancestor = await git(['merge-base', '--is-ancestor', remote, 'HEAD'], wt.path);
    if (ancestor.exitCode === 0) {
      debug?.(
        fetch.exitCode === 0
          ? `[driver] ticket ${parentId}: ${remote} already integrated into HEAD — skipping`
          : `[driver] ticket ${parentId}: git fetch failed but ${remote} is already integrated into HEAD — skipping`,
      );
      continue;
    }

    if (fetch.exitCode !== 0) {
      return parkParent(
        store,
        parentId,
        'awaiting-subtask',
        `sub-task integration failed: git fetch failed integrating ${keys} — ${brief(fetch)}`,
        debug,
      );
    }

    // A merge is needed: refuse a dirty TRACKED tree. Untracked files are not
    // karst's to reason about and must not block integration.
    const status = await git(['status', '--porcelain', '--untracked-files=no'], wt.path);
    if (status.exitCode !== 0) {
      return parkParent(
        store,
        parentId,
        'awaiting-subtask',
        `sub-task integration failed: git status failed integrating ${keys} — ${brief(status)}`,
        debug,
      );
    }
    if (status.stdout.trim()) {
      return parkParent(
        store,
        parentId,
        'awaiting-subtask',
        `commit or stash parent changes to integrate ${keys}`,
        debug,
      );
    }

    const ff = await git(['merge', '--ff-only', remote], wt.path);
    if (ff.exitCode === 0) {
      debug?.(`[driver] ticket ${parentId}: ff-only merge of ${remote} succeeded for ${keys}`);
      continue;
    }

    const merge = await git(['merge', '--no-edit', remote], wt.path);
    if (merge.exitCode === 0) {
      debug?.(`[driver] ticket ${parentId}: merge of ${remote} succeeded for ${keys}`);
      continue;
    }

    // A conflict is classified by git state, never by parsing prose: MERGE_HEAD
    // exists only while a merge is in progress.
    const mergeHead = await git(['rev-parse', '--verify', 'MERGE_HEAD'], wt.path);
    if (mergeHead.exitCode === 0) {
      debug?.(`[driver] ticket ${parentId}: merge conflict in '${wt.repo}' for ${keys} — aborting`);
      // `--diff-filter=U` over the WORKING TREE is the one that names unmerged
      // files; `diff-index ... HEAD` returns empty in a conflicted merge.
      const diff = await git(['diff', '--name-only', '--diff-filter=U'], wt.path);
      const files =
        diff.exitCode === 0
          ? diff.stdout
              .split('\n')
              .map((f) => f.trim())
              .filter((f) => f !== '')
          : [];

      const abort = await git(['merge', '--abort'], wt.path);
      if (abort.exitCode !== 0) {
        return parkParent(
          store,
          parentId,
          'subtask-integration-conflict',
          `${keys}: merge conflict in ${wt.repo}; git merge --abort failed (${brief(abort)}) — ` +
            'the worktree is mid-merge and needs manual cleanup',
          debug,
        );
      }
      const fileList = files.length > 0 ? ` (${files.join(', ')})` : '';
      return parkParent(
        store,
        parentId,
        'subtask-integration-conflict',
        `${keys}: merge conflict in ${wt.repo}${fileList}`,
        debug,
      );
    }

    // The merge failed without entering a conflict state (e.g. a local change
    // would be overwritten). Advancing now would silently drop the child's work.
    return parkParent(
      store,
      parentId,
      'awaiting-subtask',
      `sub-task integration failed: git merge of ${remote} failed integrating ${keys} — ${brief(merge)}`,
      debug,
    );
  }

  debug?.(`[driver] ticket ${parentId}: sub-task integration complete`);
  return { parked: false, deferred: false };
}

/**
 * Integrate the parent's landed sub-tasks, then release its `awaiting-subtask`
 * gate — in that order, so the gate is never cleared while the child's work is
 * still unmerged. A park from integration holds the gate; the caller must check
 * `parked` before running any gating predicate that could clear it.
 *
 * The one async seam every landing path and driver boundary funnels through.
 */
export async function integrateAndReleaseParent(
  store: Store,
  parentId: number,
  git?: GitRunner,
  debug?: (message: string) => void,
): Promise<IntegrateOutcome> {
  if (git) {
    let outcome: IntegrateOutcome;
    try {
      outcome = await integrateLandedSubtasks(store, parentId, git, debug);
    } catch (err) {
      // A throw is a failure, not a release. Park and hold — releasing without
      // the child's work is the exact failure NDL-75 exists to prevent.
      const reason = `sub-task integration failed: ${messageOf(err)}`;
      debug?.(`[driver] ticket ${parentId}: ${reason}`);
      return parkParent(store, parentId, 'awaiting-subtask', reason, debug);
    }
    if (outcome.parked) return outcome;
    // Only a real integration may clear a park. A deferral (parent running) did
    // nothing, and the no-worktree / no-landed-children results have no park to
    // clear anyway — but the deferral must be treated as distinct so a stale
    // park is not silently dropped.
    if (!outcome.deferred) clearIntegrationParks(store, parentId, debug);
  } else {
    debug?.(`[driver] ticket ${parentId}: no git runner — skipping sub-task integration`);
  }
  try {
    onSubtaskLanded(store, parentId, { debug });
  } catch (err) {
    debug?.(`[driver] ticket ${parentId}: sub-task landing release failed: ${messageOf(err)}`);
  }
  return { parked: false, deferred: false };
}

/**
 * A sub-task reached `done`; release its parent. Resolves the parent from the
 * landed sub-task, then runs the same integrate-then-release step. A no-op for
 * an ordinary top-level ticket.
 */
export async function releaseLandedSubtask(
  store: Store,
  subtaskTicketId: number,
  git?: GitRunner,
  debug?: (message: string) => void,
): Promise<void> {
  const parentId = getTicket(store, subtaskTicketId).subtaskParentId;
  if (parentId === null) return;
  await integrateAndReleaseParent(store, parentId, git, debug);
}
