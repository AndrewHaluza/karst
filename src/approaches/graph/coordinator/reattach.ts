/**
 * Session re-attach (Slice 3 Task 7 follow-up).
 *
 * A graph session's transport registry is in-memory and recreated fresh on
 * every activation, while the terminals themselves survive a reload. After a
 * reload the coordinator must re-attach a live graph session to the active
 * window — otherwise `openSession` reports "its session is not attached to
 * this window" and the run stalls with no interaction path, which is exactly
 * the reported defect.
 *
 * `reattachableSessionIdentity` is the pure read that resolves a revived
 * terminal's `KARST_LAUNCH_ID` (the node-run id, or planner-run id) to the
 * durable session identity the transport needs to register it again. It uses
 * the SAME gate `adoptionSurface` enforces — only terminals whose launchId
 * matches a live node/planner run of the ACTIVE graph are re-attached, and a
 * terminal this window never launched is never adopted. The host then wraps
 * the revived vscode terminal as a `TransportTerminal`, assembles the
 * `SupervisedAgentSession`, and calls `SupervisedCliTransport.adopt`.
 *
 * Host-agnostic: db reads only; no vscode, no transport, no stage machine.
 */

import type { GraphDb } from '../../../store/graph/transitions.js';
import { nodeRunSessionIdentity } from '../../../store/graph/nodeRuns.js';
import { plannerRunSessionIdentity } from '../../../store/graph/plannerRuns.js';
import { adoptionSurface } from '../entryPoints.js';

export interface ReattachIdentity {
  kind: 'node' | 'planner';
  nodeRunId: number;
  graphRunId: number;
  processRunId: number | null;
  pid: number | null;
  startedAt: string | null;
  generation: string;
  ownerNonce: string;
}

interface ProcessRow {
  pid: number | null;
  started_at: string;
}

/**
 * Resolve a revived terminal's launch id to the durable identity of the live
 * node/planner run it belongs to. Undefined when the launchId is not a live
 * run of the ticket's active graph (the `adoptionSurface` gate), is not
 * numeric, or matches no run row — such a terminal is never re-attached.
 */
export function reattachableSessionIdentity(
  db: GraphDb,
  input: { ticketId: number; launchId: string },
): ReattachIdentity | undefined {
  if (adoptionSurface(db, input.ticketId, input.launchId) !== 'adopt') return undefined;
  const runId = /^[1-9]\d*$/.test(input.launchId) ? Number(input.launchId) : NaN;
  if (!Number.isInteger(runId) || runId <= 0) return undefined;

  const nodeRun = nodeRunSessionIdentity(db, runId);
  const plannerRun = nodeRun ? undefined : plannerRunSessionIdentity(db, runId);
  const run = nodeRun ?? plannerRun;
  if (!run) return undefined;

  let pid: number | null = null;
  let startedAt = run.started_at;
  if (run.process_run_id !== null) {
    const process = db
      .prepare('SELECT pid, started_at FROM process_runs WHERE id = ?')
      .get(run.process_run_id) as ProcessRow | undefined;
    if (process) {
      pid = process.pid;
      startedAt = process.started_at ?? startedAt;
    }
  }

  return {
    kind: nodeRun ? 'node' : 'planner',
    nodeRunId: runId,
    graphRunId: run.graph_run_id,
    processRunId: run.process_run_id,
    pid,
    startedAt,
    generation: run.generation ?? '',
    ownerNonce: run.owner_nonce ?? '',
  };
}
