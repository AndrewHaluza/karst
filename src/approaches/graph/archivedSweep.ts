/**
 * Archived-ticket graph sweep (T1342).
 *
 * A graph node workspace is a full repository clone (`workspaces/<nodeRunId>/`),
 * so it is the bulk of a ticket's graph bytes. The normal cleanup runs when a
 * graph run closes; a run that ends `cancelled` never got it, and a node left
 * `stale` inside a terminal run kept its tree forever. Archive also never ended
 * an open run, so an archived ticket could hold a `running` run for months.
 *
 * This sweep closes both gaps for tickets of the CURRENT PROJECT that were
 * archived more than one hour ago and have no live session:
 *
 *  1. every graph run not in `closed`/`cancelled` is cancelled through the one
 *     Cancel operation (`cancel.ts`) with reason `ticket archived`. A refusal
 *     (a foreign or unknown live pid, or a denied kill) leaves the run and its
 *     workspaces untouched and logs one debug line — attribution first, never a
 *     blind signal;
 *  2. every graph run in `closed`/`cancelled` has its node workspaces removed
 *     with `includeStaleNodes: true`, which widens the cleanable node statuses
 *     to `stale`, `failed-to-launch`, `failed` and `ready` for a terminal run
 *     only. A `running` node workspace is never removed.
 *
 * Only `workspaces/<nodeRunId>/` is removed: `<run>/artifacts/` and everything
 * else stays as evidence. The 1-hour grace and the live-session check mirror
 * `archiveInactiveWorktrees` with `onlyArchived`.
 *
 * The store read (`graphRunsForArchivedTicketsBefore`) is STATE-DRIVEN: it
 * returns an open run, or a terminal run that still has a cleanable node with a
 * workspace-ledger row. A cleaned terminal run drops out, so the 60-second PR
 * tick never re-walks the whole run/node history of every archived ticket.
 *
 * Host-agnostic: store, transaction, process facts, kill and clock are injected;
 * no vscode and no logger.
 */

import type { Store } from '../../store/db.js';
import { graphRunsForArchivedTicketsBefore } from '../../store/graph/graphRuns.js';
import { cancelGraphRun } from './cancel.js';
import { cleanupTerminalGraphRunWorkspaces } from './workspace/cleanup.js';
import type { ProcessFacts, ProcessFactsSource } from '../../runtime/serverIdentity.js';
import type { KillOutcome } from '../../runtime/processTree.js';

export const ARCHIVED_TICKET_CANCEL_REASON = 'ticket archived';
export const ARCHIVED_SWEEP_GRACE_MS = 60 * 60 * 1000;

export interface SweepArchivedTicketGraphRunsDeps {
  store: Store;
  /** BEGIN IMMEDIATE-wrapped, all-or-nothing; a throw rolls back. */
  transaction: <T>(fn: () => T) => T;
  /** Async process probes for the cancel attribution. */
  facts: ProcessFactsSource;
  /** Optional sync process probes for workspace server reaping (system probes when omitted). */
  cleanupFacts?: ProcessFacts;
  killTree: (pid: number) => KillOutcome;
  isSessionLive?: (ticketId: number) => boolean;
  now?: () => string;
  graceMs?: number;
  debug?: (message: string) => void;
}

export interface ArchivedGraphSweepResult {
  cancelledRunIds: number[];
  refusedRunIds: number[];
  removedNodeRunIds: number[];
  releasedBytes: number;
}

/**
 * Cancel the still-open graph runs of archived tickets and remove the node
 * workspaces of their terminal runs. Returns what it did: the runs cancelled,
 * the runs it refused to touch, and the node workspaces removed with the bytes
 * they released.
 */
export async function sweepArchivedTicketGraphRuns(
  deps: SweepArchivedTicketGraphRunsDeps,
  projectId: number,
): Promise<ArchivedGraphSweepResult> {
  const nowIso = (deps.now ?? (() => new Date().toISOString()))();
  const graceMs = deps.graceMs ?? ARCHIVED_SWEEP_GRACE_MS;
  const cutoffIso = new Date(Date.parse(nowIso) - graceMs).toISOString();

  const runs = graphRunsForArchivedTicketsBefore(deps.store.db, projectId, cutoffIso);
  const livenessByTicket = new Map<number, boolean>();
  const liveSession = (ticketId: number): boolean => {
    const cached = livenessByTicket.get(ticketId);
    if (cached !== undefined) return cached;
    const live = deps.isSessionLive?.(ticketId) === true;
    livenessByTicket.set(ticketId, live);
    return live;
  };

  const cancelledRunIds: number[] = [];
  const refusedRunIds: number[] = [];
  const removedNodeRunIds: number[] = [];
  let releasedBytes = 0;

  for (const run of runs) {
    if (liveSession(run.ticketId)) continue;

    let status = run.status;
    if (status !== 'closed' && status !== 'cancelled') {
      const outcome = await cancelGraphRun(
        {
          db: deps.store.db,
          transaction: deps.transaction,
          facts: deps.facts,
          killTree: deps.killTree,
          now: deps.now,
          debug: deps.debug,
        },
        run.graphRunId,
        ARCHIVED_TICKET_CANCEL_REASON,
      );
      if (outcome.outcome === 'cancelled') {
        cancelledRunIds.push(run.graphRunId);
        status = 'cancelled';
      } else if (outcome.outcome === 'refused-live-process') {
        refusedRunIds.push(run.graphRunId);
        deps.debug?.(
          `[graph] archived sweep: run ${run.graphRunId} left open — ${outcome.refusals.length} unattributable live pid(s)`,
        );
        continue;
      } else if (outcome.outcome === 'already-terminal') {
        status = outcome.status ?? status;
      } else {
        continue;
      }
    }

    if (status !== 'closed' && status !== 'cancelled') continue;

    const results = cleanupTerminalGraphRunWorkspaces(
      {
        store: deps.store,
        transaction: deps.transaction,
        facts: deps.cleanupFacts,
        debug: deps.debug,
      },
      { graphRunId: run.graphRunId, includeStaleNodes: true },
    );
    for (const result of results) {
      if (result.kind !== 'removed') continue;
      removedNodeRunIds.push(result.nodeRunId);
      releasedBytes += result.releasedBytes;
    }
  }

  return { cancelledRunIds, refusedRunIds, removedNodeRunIds, releasedBytes };
}
