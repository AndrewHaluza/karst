import type { Store } from '../store/db.js';
import { STAGE_KEYS, type StageKey } from '../model/types.js';
import { getTicket } from '../store/tickets.js';
import { listAwaitingSubtaskParentIds } from '../store/subtasks.js';
import { setStage } from '../store/stages.js';
import { stageBlock, clearStageBlock } from '../store/stageBlocks.js';
import { nowIso } from '../model/time.js';
import { markImplementDone } from './stages/implement.js';
import { markFixDone } from './fixExecution.js';
import { BUILT_IN_PACKAGE_ID } from '../approaches/builtInId.js';

/**
 * Sub-task gating (design NDL-70 §5). A parent's delivery path blocks on its
 * own sub-tasks: `leave-impl` holds a parent at `impl`/`fix` until every
 * BLOCKING sub-task is done, and `ship` holds it at `ship` until every stacked
 * sub-task has landed.
 *
 * The deciding logic is ONE pure predicate, `openGatingSubtasks`, a read over
 * state karst already keeps current (ticket stages, worktree base refs). The
 * rest of this module is the "settle" shape borrowed from `workflow/mergeGate`:
 * a park (a read plus one block write) and a re-derivation that may clear it,
 * but never while the predicate is still non-empty.
 *
 * vscode-free. Nothing here runs git or gh; landing a sub-task is a human's
 * click (`workflow/mergePr.ts`) and integrating the result is NDL-75's job,
 * injected into `onSubtaskLanded`.
 */

/** The two gate conditions a parent can be held on (design §5). */
export type SubtaskGate = 'leave-impl' | 'ship';

/** A sub-task that holds its parent, with the stage the reason names. */
export interface OpenGatingSubtask {
  id: number;
  key: string;
  /** The sub-task's current stage — for the block reason ("PROJ-1-s2 (review)"). */
  stage: string;
}

/**
 * The one pure predicate (design §5). Returns the DIRECT sub-tasks that hold
 * the parent for `gate`:
 *
 * - `leave-impl`: `blocks_parent = 1`, not archived, not `done`;
 * - `ship`: not archived, not `done`, and carrying a `worktrees` row whose
 *   `base_ref` is the PARENT'S branch for that same repo — a started stack. A
 *   non-blocking sub-task that has not started does not hold the ship (§4).
 *
 * Direct children only: a grandchild blocks its own parent, which in turn
 * blocks the grandparent — recursion by construction.
 *
 * Read-only; ordered by id so the reason text is stable.
 */
export function openGatingSubtasks(
  store: Store,
  parentId: number,
  gate: SubtaskGate,
): OpenGatingSubtask[] {
  if (gate === 'leave-impl') {
    return store.db
      .prepare(
        `SELECT id, key, COALESCE(stage_current, '') AS stage
           FROM tickets
          WHERE subtask_parent_id = ?
            AND blocks_parent = 1
            AND archived_at IS NULL
            AND COALESCE(stage_current, '') != 'done'
          ORDER BY id`,
      )
      .all(parentId) as OpenGatingSubtask[];
  }
  // A started stack: the child's worktree was cut from the parent's branch for
  // the SAME repo (NDL-72). `repo` is the repoPath, so a shared-repoPath
  // monorepo entry matches on its one worktree. A parent with no worktree in
  // that repo has no branch to match — the join simply excludes it.
  return store.db
    .prepare(
      `SELECT DISTINCT t.id, t.key, COALESCE(t.stage_current, '') AS stage
         FROM tickets t
         INNER JOIN worktrees cw ON cw.ticket_id = t.id
         INNER JOIN worktrees pw
                 ON pw.ticket_id = ?
                AND pw.repo = cw.repo
                AND pw.branch IS NOT NULL
                AND cw.base_ref = pw.branch
        WHERE t.subtask_parent_id = ?
          AND t.archived_at IS NULL
          AND COALESCE(t.stage_current, '') != 'done'
        ORDER BY t.id`,
    )
    .all(parentId, parentId) as OpenGatingSubtask[];
}

/**
 * The block reason shown verbatim by the dashboard's chip and rail, e.g.
 * "waiting on PROJ-1-s2 (review), PROJ-1-s3 (impl)".
 */
export function describeAwaitingSubtask(subtasks: readonly OpenGatingSubtask[]): string {
  return `waiting on ${subtasks.map((s) => `${s.key} (${s.stage})`).join(', ')}`;
}

/** The gate a parked stage belongs to. Only `ship` uses the ship predicate. */
function gateForStage(stage: StageKey): SubtaskGate {
  return stage === 'ship' ? 'ship' : 'leave-impl';
}

/**
 * Park `stage` with an `awaiting-subtask` block: the stage's own work is either
 * complete (`impl`/`fix`, whose verdict the marker supplied) or never started
 * (`ship`, still awaiting its confirm click), and only the sub-tasks are left.
 *
 * `awaiting-subtask` is a cache of a derived fact (design §5): it is written
 * here and re-derived on boot (`recoverAwaitingSubtasks`), never trusted as
 * ground truth on its own.
 */
function parkAwaitingSubtask(
  store: Store,
  ticketId: number,
  stage: StageKey,
  subtasks: readonly OpenGatingSubtask[],
): void {
  setStage(store, ticketId, stage, {
    status: stage === 'ship' ? 'pending' : 'passed',
    verdict: null,
    endedAt: stage === 'ship' ? null : nowIso(),
    blockedKind: 'awaiting-subtask',
    blockedReason: describeAwaitingSubtask(subtasks),
    blockedAt: nowIso(),
  });
}

/**
 * Whether an `awaiting-subtask` block is an INTEGRATION park (a dirty tree, a
 * git failure, or a merge conflict — NDL-75) rather than the gate's own
 * "waiting on <sub-task>". The two share the kind because both hold the parent
 * on the same plumbing; they differ in what clears them. A gate park clears
 * when the predicate empties; an integration park clears only when integration
 * actually succeeds (or the user resolves it). The gate park's reason is the
 * one shape `describeAwaitingSubtask` writes, so anything else is integration.
 */
export function isIntegrationParkReason(reason: string | null | undefined): boolean {
  return reason != null && !reason.startsWith('waiting on ');
}

/**
 * Drop every integration park on the ticket's stages. Called ONLY after an
 * integration attempt succeeded: the refusal no longer holds, so a gate park
 * (if the predicate is still non-empty) can be written fresh by the next
 * `settleSubtaskGate`. `onSubtaskLanded` deliberately refuses to clear these
 * itself — a gate predicate going empty is not proof the work merged.
 */
export function clearIntegrationParks(
  store: Store,
  ticketId: number,
  debug?: (message: string) => void,
): void {
  // EVERY stage, not just impl|fix|ship: integration can park the parent's
  // current stage, which may be uat/review when the driver seam runs there.
  for (const stage of STAGE_KEYS) {
    const block = stageBlock(store, ticketId, stage);
    if (block?.kind === 'awaiting-subtask' && isIntegrationParkReason(block.reason)) {
      debug?.(`[driver] ticket ${ticketId}: clearing integration park on '${stage}'`);
      clearStageBlock(store, ticketId, stage);
    }
  }
}

/**
 * Evaluate a stage's gate and park it when closed. Returns `{ blocked: true }`
 * when the caller must NOT advance past `stage`.
 *
 * An integration park holds the stage unconditionally: the child's work has not
 * merged, so an empty predicate is not permission to advance. Only a successful
 * integration (which clears the park via `clearIntegrationParks`) may release
 * it — that is what makes the integration seam the gate's real precondition.
 *
 * When the gate is open and no integration park is present, a STALE
 * `awaiting-subtask` block on the row is cleared: a stale block would otherwise
 * outlive the pass it was cached for (the machine's `transition` does not touch
 * `blocked_*`), leaving a passed stage with a phantom block.
 *
 * A failure to write the block IS allowed to propagate: unlike ship's tail
 * (whose irreversible work already happened), nothing has advanced yet, so
 * failing the marker is the safe answer.
 */
export function settleSubtaskGate(
  store: Store,
  ticketId: number,
  stage: StageKey,
  debug?: (message: string) => void,
): { blocked: boolean } {
  const existing = stageBlock(store, ticketId, stage);
  if (existing?.kind === 'awaiting-subtask' && isIntegrationParkReason(existing.reason)) {
    debug?.(
      `[driver] ticket ${ticketId}: '${stage}' held by a sub-task integration park — not advancing`,
    );
    return { blocked: true };
  }
  const subtasks = openGatingSubtasks(store, ticketId, gateForStage(stage));
  if (subtasks.length === 0) {
    if (existing?.kind === 'awaiting-subtask') {
      debug?.(`[driver] ticket ${ticketId}: gate open at '${stage}' — clearing stale sub-task block`);
      clearStageBlock(store, ticketId, stage);
    }
    return { blocked: false };
  }
  debug?.(
    `[driver] ticket ${ticketId}: '${stage}' held by ${subtasks.length} sub-task(s): ` +
      subtasks.map((s) => `${s.key} (${s.stage})`).join(', '),
  );
  parkAwaitingSubtask(store, ticketId, stage, subtasks);
  return { blocked: true };
}

/**
 * Re-derive an `awaiting-subtask` block on one stage. Clears it only when the
 * predicate is now empty; while it is still non-empty the block is left exactly
 * as it is — the same rule `awaiting-merge` follows (design §5: "may not clear
 * it while the predicate is non-empty").
 */
export function reconcileAwaitingSubtaskBlock(
  store: Store,
  ticketId: number,
  stage: StageKey,
  debug?: (message: string) => void,
): { cleared: boolean } {
  const block = stageBlock(store, ticketId, stage);
  if (block?.kind !== 'awaiting-subtask') {
    debug?.(`[driver] ticket ${ticketId}: no awaiting-subtask block on '${stage}' — nothing to reconcile`);
    return { cleared: false };
  }
  if (isIntegrationParkReason(block.reason)) {
    debug?.(
      `[driver] ticket ${ticketId}: awaiting-subtask on '${stage}' is an integration park — leaving it`,
    );
    return { cleared: false };
  }
  const subtasks = openGatingSubtasks(store, ticketId, gateForStage(stage));
  if (subtasks.length > 0) {
    debug?.(
      `[driver] ticket ${ticketId}: awaiting-subtask block on '${stage}' still valid ` +
        `(${subtasks.length} open) — not clearing`,
    );
    return { cleared: false };
  }
  debug?.(`[driver] ticket ${ticketId}: awaiting-subtask block on '${stage}' can clear — clearing`);
  clearStageBlock(store, ticketId, stage);
  return { cleared: true };
}

/** Options for `onSubtaskLanded`. */
export interface OnSubtaskLandedOpts {
  debug?: (message: string) => void;
}

/**
 * A sub-task reached `done` (its PR merged). Re-derive the parent's
 * `awaiting-subtask` blocks; for the stage the parent is actually parked at,
 * clear and drive it forward — `impl`/`fix` complete their marker run and
 * advance to `uat`; `ship` returns to its confirm click.
 *
 * The gate parks are re-derived here; an INTEGRATION park is left alone —
 * integration is NDL-75's job (`integrateAndReleaseParent`), which runs BEFORE
 * this call and clears its own park only on success. A caller that reaches here
 * without integrating first must not clear an integration park, so this refuses
 * to (`isIntegrationParkReason`).
 *
 * The "settle" shape of `mergeGate`: a read plus at most one transition. Called
 * from the sub-task's done transition via `integrateAndReleaseParent` and from
 * boot reconciliation for a landing that happened while no window was open.
 */
export function onSubtaskLanded(
  store: Store,
  parentId: number,
  opts: OnSubtaskLandedOpts = {},
): { cleared: StageKey[] } {
  const parent = getTicket(store, parentId);
  const idle = parent.agentState !== 'running';
  if (!idle) {
    opts.debug?.(`[driver] ticket ${parentId}: agent is running — deferring sub-task release`);
  }

  const cleared: StageKey[] = [];
  for (const stage of ['impl', 'fix', 'ship'] as const) {
    if (stageBlock(store, parentId, stage)?.kind !== 'awaiting-subtask') continue;
    if (!reconcileAwaitingSubtaskBlock(store, parentId, stage, opts.debug).cleared) continue;
    cleared.push(stage);
    // Drive only the stage the parent is actually sitting at, and only while no
    // agent owns the tree (a live parent fires its own marker, which now passes).
    if (!idle || getTicket(store, parentId).stageCurrent !== stage) continue;
    if (stage === 'impl') {
      // A graph-approach parent's impl marker is the graph/stage boundary's to
      // fire (`graphMarkerGuard`, reachable only through `cli/stage.ts` and
      // pinned there by `graphBoundary.test.ts`). This module must not reach
      // it, so the block is cleared and the marker is left to the graph guard.
      if (parent.approach === BUILT_IN_PACKAGE_ID) {
        opts.debug?.(
          `[driver] ticket ${parentId}: graph-approach parent released at impl — ` +
            're-fire the impl marker to close the graph run',
        );
        continue;
      }
      markImplementDone(store, parentId, undefined, opts.debug);
    } else if (stage === 'fix') {
      markFixDone(store, parentId);
    }
  }
  return { cleared };
}

/**
 * Boot re-derivation (design §5): every ticket parked `awaiting-subtask` has
 * its block re-evaluated, so a sub-task that landed while no window was open
 * does not leave the parent stuck behind a stale block. Delegates to
 * `onSubtaskLanded` so a cleared block also drives the parent, and swallows a
 * per-ticket failure — boot must never fail on one ticket's derived state.
 */
export function recoverAwaitingSubtasks(
  store: Store,
  debug?: (message: string) => void,
): void {
  for (const id of listAwaitingSubtaskParentIds(store)) {
    try {
      onSubtaskLanded(store, id, { debug });
    } catch (err) {
      debug?.(
        `[driver] ticket ${id}: sub-task block re-derivation failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}
