import type { Store } from '../store/db.js';
import type { StageKey } from '../model/types.js';
import { getTicket, listTickets } from '../store/tickets.js';
import { listWorktreesByTicket } from '../store/dashboard.js';
import { setStage } from '../store/stages.js';
import { nowIso } from '../model/time.js';
import type { GitRunner } from '../integrations/git.js';

/**
 * Integrate a landed sub-task's work into its parent's local branch (NDL-75,
 * design §6). Called from `onSubtaskLanded` when the parent is idle, or
 * injected into the parent's driver seams (leave-impl/ship entry) before the
 * gating predicate runs.
 *
 * For each repo the parent has a worktree in:
 * 1. Fetch the parent's branch from origin
 * 2. Try ff-only merge of the sub-task's branch
 * 3. If that fails, try git merge --no-edit (no rebase, shared history)
 * 4. Classify MERGE_HEAD conflicts by git state, abort, and park with
 *    subtask-integration-conflict, naming the sub-task and files
 * 5. Dirty tracked tree: refuse with awaiting-subtask park, naming the
 *    sub-task
 *
 * All git operations run via the injected async GitRunner (never spawnSync),
 * and all branches log via the injected logger with [driver] prefix.
 */
export async function integrateLandedSubtasks(
  store: Store,
  parentId: number,
  git: GitRunner,
  debug?: (message: string) => void,
): Promise<void> {
  const parent = getTicket(store, parentId);
  if (!parent) {
    debug?.(`[driver] ticket ${parentId}: parent not found`);
    return;
  }

  const parentWorktrees = listWorktreesByTicket(store, parentId);
  if (parentWorktrees.length === 0) {
    debug?.(`[driver] ticket ${parentId}: parent has no worktrees`);
    return;
  }

  const children = store.db
    .prepare(
      `SELECT id, key FROM tickets
         WHERE subtask_parent_id = ?
           AND stage_current = 'done'
           AND archived_at IS NULL`,
    )
    .all(parentId) as { id: number; key: string }[];

  if (children.length === 0) {
    debug?.(`[driver] ticket ${parentId}: no landed sub-tasks to integrate`);
    return;
  }

  for (const wt of parentWorktrees) {
    if (!wt.branch) continue;

    debug?.(`[driver] ticket ${parentId}: integrating sub-tasks in repo '${wt.repo}'`);

    // Check for dirty tracked tree first
    const statusResult = await git(['status', '--porcelain'], wt.path);
    if (statusResult.exitCode !== 0) {
      debug?.(`[driver] ticket ${parentId}: git status failed in '${wt.repo}': ${statusResult.stderr}`);
      continue;
    }
    if (statusResult.stdout.trim()) {
      // There are uncommitted changes
      const childrenList = children.map((c) => c.key).join(', ');
      debug?.(`[driver] ticket ${parentId}: dirty tracked tree in '${wt.repo}' — parking awaiting-subtask`);
      const stage = parent.stageCurrent as StageKey;
      setStage(store, parentId, stage, {
        blockedKind: 'awaiting-subtask',
        blockedReason: `commit or stash parent changes to integrate ${childrenList}`,
        blockedAt: nowIso(),
      });
      return;
    }

    // Find sub-tasks in this repo
    const childWorktrees = store.db
      .prepare(
        `SELECT t.id, t.key, cw.branch FROM tickets t
           INNER JOIN worktrees cw ON cw.ticket_id = t.id
          WHERE t.subtask_parent_id = ?
            AND cw.repo = ?
            AND t.stage_current = 'done'
            AND t.archived_at IS NULL`,
      )
      .all(parentId, wt.repo) as { id: number; key: string; branch: string | null }[];

    for (const child of childWorktrees) {
      if (!child.branch) continue;

      debug?.(`[driver] ticket ${parentId}: integrating ${child.key} into ${wt.repo}`);

      // Fetch the parent's branch from origin
      const fetchResult = await git(['fetch', 'origin', wt.branch], wt.path);
      if (fetchResult.exitCode !== 0) {
        debug?.(`[driver] ticket ${parentId}: fetch failed for ${wt.branch}: ${fetchResult.stderr}`);
        continue;
      }

      // Try ff-only merge first
      debug?.(`[driver] ticket ${parentId}: attempting ff-only merge of ${child.branch} into ${wt.branch}`);
      const ffMergeResult = await git(['merge', '--ff-only', child.branch], wt.path);

      if (ffMergeResult.exitCode === 0) {
        debug?.(`[driver] ticket ${parentId}: ff-only merge succeeded for ${child.key}`);
        continue;
      }

      // ff-only failed, try regular merge
      debug?.(`[driver] ticket ${parentId}: ff-only merge failed, trying git merge --no-edit`);
      const mergeResult = await git(['merge', '--no-edit', child.branch], wt.path);

      if (mergeResult.exitCode === 0) {
        debug?.(`[driver] ticket ${parentId}: merge succeeded for ${child.key}`);
        continue;
      }

      // Merge failed — check if it's a MERGE_HEAD conflict
      const mergeHeadResult = await git(['rev-parse', 'MERGE_HEAD'], wt.path);
      if (mergeHeadResult.exitCode === 0) {
        // MERGE_HEAD exists — we're in a merge conflict state
        debug?.(`[driver] ticket ${parentId}: merge conflict detected in ${wt.repo} for ${child.key} — aborting`);

        // Get the conflicted files
        const diffIndexResult = await git(['diff-index', '--name-only', '--diff-filter=U', 'HEAD'], wt.path);
        const conflictedFiles =
          diffIndexResult.exitCode === 0 ? diffIndexResult.stdout.trim().split('\n').filter((f) => f) : [];

        // Abort the merge
        const abortResult = await git(['merge', '--abort'], wt.path);
        if (abortResult.exitCode !== 0) {
          debug?.(`[driver] ticket ${parentId}: merge --abort failed: ${abortResult.stderr}`);
          continue;
        }

        // Park with subtask-integration-conflict
        const conflictList = conflictedFiles.length > 0 ? ` (${conflictedFiles.join(', ')})` : '';
        const stage = parent.stageCurrent as StageKey;
        setStage(store, parentId, stage, {
          blockedKind: 'subtask-integration-conflict',
          blockedReason: `${child.key}: merge conflict in ${wt.repo}${conflictList}`,
          blockedAt: nowIso(),
        });
        return;
      }

      // Not a MERGE_HEAD conflict — regular merge failure
      debug?.(`[driver] ticket ${parentId}: merge failed for ${child.key}: ${mergeResult.stderr}`);
      continue;
    }
  }
}
