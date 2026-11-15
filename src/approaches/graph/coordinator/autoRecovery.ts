/**
 * Automatic recovery of a blocked graph run (T1151).
 *
 * The coordinator sweep lists the blocked runs it may recover and calls
 * `recoverGraphRun` (mode `resume`, never `force-resume`) for the block
 * reasons whose category is safe to retry without a human: `launch-retry`,
 * `planner-relaunch`, `replan` and `compile-new-revision`. A manual category
 * (discard-required, artifact-recheck, explicit-resolution, config-then-resume,
 * prompt-resnapshot, unknown) never reaches `recoverGraphRun` from here.
 *
 * Each run gets at most `AUTO_RECOVERY_LIMIT` automatic recoveries. The count
 * is durable (`approach_graph_runs.auto_recovery_count`), so a reload or a
 * second window cannot reset it, and a human Resume or Replan does not reset it
 * either. At the limit the run stays blocked and its reason gains one stop note
 * that lists the reasons already recovered.
 *
 * Host-agnostic: the recovery call (which also launches the planner or wakes
 * the run), the bulletin note and the debug line are injected. The sweep shows
 * no dialog.
 */

import type { GraphDb } from '../../../store/graph/transitions.js';
import {
  graphRunAutoRecovery,
  graphRunIdStatusBlockedReason,
  noteGraphRunAutoRecoveryStopped,
  recordGraphRunAutoRecovery,
} from '../../../store/graph/graphRuns.js';
import { emitGraphDiagnostic } from '../diagnostics.js';
import { recoveryCategoryFor, type RecoveryCategory, type RecoveryResult } from './recovery.js';

/** The most automatic recoveries one graph run gets before a human must act. */
export const AUTO_RECOVERY_LIMIT = 3;

/** The categories the coordinator recovers by itself. */
const AUTOMATIC_CATEGORIES: readonly RecoveryCategory[] = [
  'launch-retry',
  'planner-relaunch',
  'replan',
  'compile-new-revision',
];

/** The longest block reason kept in the recovered-reasons history. */
const MAX_HISTORY_REASON_CHARS = 200;

/** True when the block reason maps to a category the coordinator recovers. */
export function isAutoRecoverableReason(reason: string | null): boolean {
  if (!reason) return false;
  return AUTOMATIC_CATEGORIES.includes(recoveryCategoryFor(reason));
}

export interface AutoRecoveryDeps {
  db: GraphDb;
  now: () => string;
  debug?: (message: string) => void;
  /** Recover one run: `recoverGraphRun` plus the launch and wake-up the result
   *  needs. The seam the buttons share. */
  recover: (input: {
    ticketId: number;
    graphRunId: number;
    mode: 'resume';
  }) => Promise<RecoveryResult>;
  /** Post one project bulletin note. */
  postNote: (note: { ticketId: number; title: string; body: string }) => void;
}

/** What the sweep remembers between ticks: the block it last saw refused, per
 *  run. A refusal changes no state, so without it the same block retries on
 *  every tick. */
export interface AutoRecoveryMemory {
  refused: Map<number, string>;
}

export function createAutoRecoveryMemory(): AutoRecoveryMemory {
  return { refused: new Map() };
}

/** The block reason's category word — the text before the first colon. */
function reasonKind(reason: string): string {
  const head = reason.split(':')[0] ?? reason;
  return head.trim();
}

function stopNote(reasons: readonly string[]): string {
  const kinds = [...new Set(reasons.map(reasonKind))];
  return (
    `automatic recovery stopped after ${AUTO_RECOVERY_LIMIT} attempts ` +
    `(recovered: ${kinds.join(', ')})`
  );
}

async function recoverOne(
  deps: AutoRecoveryDeps,
  memory: AutoRecoveryMemory,
  target: { graphRunId: number; ticketId: number },
): Promise<void> {
  const { graphRunId, ticketId } = target;
  const run = graphRunIdStatusBlockedReason(deps.db, graphRunId);
  if (!run || run.status !== 'blocked') {
    memory.refused.delete(graphRunId);
    return;
  }
  const reason = run.blocked_reason;
  if (reason === null || !isAutoRecoverableReason(reason)) return;
  if (memory.refused.get(graphRunId) === reason) return;

  const history = graphRunAutoRecovery(deps.db, graphRunId);
  if (history.count >= AUTO_RECOVERY_LIMIT) {
    const note = stopNote(history.reasons);
    if (noteGraphRunAutoRecoveryStopped(deps.db, graphRunId, note, deps.now())) {
      emitGraphDiagnostic({ db: deps.db, debug: deps.debug }, {
        category: 'recovery',
        graphRunId,
        detail: `${note}; a human Resume or Replan is needed — ${reason}`,
      });
      deps.postNote({
        ticketId,
        title: `graph run ${graphRunId}: automatic recovery stopped`,
        body: `${note}. The run stays blocked on: ${reason}`,
      });
    }
    return;
  }

  const result = await deps.recover({ ticketId, graphRunId, mode: 'resume' });
  if (result.kind === 'no-op') return;
  if (result.kind === 'refused') {
    memory.refused.set(graphRunId, reason);
    emitGraphDiagnostic({ db: deps.db, debug: deps.debug }, {
      category: 'recovery',
      graphRunId,
      detail: `automatic recovery refused (${result.reason}): ${reason}`,
    });
    return;
  }
  memory.refused.delete(graphRunId);
  recordGraphRunAutoRecovery(
    deps.db,
    graphRunId,
    reason.slice(0, MAX_HISTORY_REASON_CHARS),
    deps.now(),
  );
  const attempt = history.count + 1;
  emitGraphDiagnostic({ db: deps.db, debug: deps.debug }, {
    category: 'recovery',
    graphRunId,
    detail: `automatic recovery ${attempt}/${AUTO_RECOVERY_LIMIT} (${result.kind}): ${reason}`,
  });
  deps.postNote({
    ticketId,
    title: `graph run ${graphRunId}: recovered automatically (${attempt}/${AUTO_RECOVERY_LIMIT})`,
    body: `The coordinator recovered a blocked graph run by itself (${result.kind}). Block reason: ${reason}`,
  });
}

/**
 * Recover each listed blocked run that has an automatic reason. One run's
 * failure is reported and never stops the others. A run that left the listed
 * set drops its refusal memory.
 */
export async function autoRecoverBlockedRuns(
  deps: AutoRecoveryDeps,
  memory: AutoRecoveryMemory,
  targets: ReadonlyArray<{ graphRunId: number; ticketId: number }>,
): Promise<void> {
  const listed = new Set(targets.map((t) => t.graphRunId));
  for (const id of [...memory.refused.keys()]) {
    if (!listed.has(id)) memory.refused.delete(id);
  }
  for (const target of targets) {
    try {
      await recoverOne(deps, memory, target);
    } catch (err) {
      deps.debug?.(
        `[graph] automatic recovery of run ${target.graphRunId} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
