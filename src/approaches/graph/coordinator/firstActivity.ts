/**
 * T1385 — the first-activity watchdog.
 *
 * A graph node can launch and never start work while its row reads `running`:
 * on 2026-11-26 the T1372 and T1371 opencode2 launches started the TUI and its
 * server, OpenCode created no session for about 10 hours, and nothing in the
 * coordinator ever looked again. The sweep tick is synchronous and the
 * transport kill is async, so this runs as a separate host step AFTER the tick.
 *
 * A node is checked only when it can report progress at all: provider
 * `opencode2`, or `claude` on HOST placement. It is stopped only when it has
 * produced NO `interactive_usage_samples` row for its `process_run_id` after
 * `FIRST_ACTIVITY_WAIT_MS` of AWAKE time — a sample at any age exempts it, and
 * host sleep does not count. The kill goes through the transport's attributable
 * termination (never a raw pid); a `denied`/`unknown` proof or a session this
 * window does not own leaves the row exactly as it was.
 *
 * Only after a successful kill is the node parked through `parkLaunchFailure`
 * with a `node-blocked:` run reason — the automatic launch-retry category, so
 * autorecovery relaunches it at most three times (@arch:GRAPH-AUTORECOVERY).
 * `providerExit = false`: this is not the provider early-exit loop, so the
 * `launch_fail_streak` is cleared, never advanced.
 *
 * Host-agnostic: store, transaction, clock, sleep ledger, the termination seam
 * and the log are injected. No vscode, no transport instance.
 */

import type { GraphDb } from '../../../store/graph/transitions.js';
import {
  runningNodeRunsForFirstActivity,
  type RunningNodeRunActivity,
} from '../../../store/graph/nodeRuns.js';
import { emitGraphDiagnostic } from '../diagnostics.js';
import { parkLaunchFailure, type GraphDriverDeps } from '../driver.js';
import type { TerminationProof } from '../transport/agentTransport.js';
import { FIRST_ACTIVITY_WAIT_MS } from './sweep.js';

/** Which live session the watchdog asks the host to terminate. */
export interface FirstActivityTarget {
  graphRunId: number;
  nodeRunId: number;
}

export interface FirstActivityWatchdogDeps {
  db: GraphDb;
  /** BEGIN IMMEDIATE-wrapped, all-or-nothing; a throw rolls back. */
  transaction: <T>(fn: () => T) => T;
  now: () => string;
  debug?: (message: string) => void;
  /** Wall time since `sinceMs`, minus host sleep; the sleep ledger's read. */
  awakeElapsedMs: (sinceMs: number, nowMs: number) => number;
  /**
   * Terminate the node's live session through the graph transport (attributable
   * kill only). Undefined = no session in this window; the row is untouched.
   */
  terminateSession: (target: FirstActivityTarget) => Promise<TerminationProof | undefined>;
}

export interface FirstActivityWatchdogResult {
  /** Running node runs the store read returned (whatever their provider). */
  checked: number;
  /** Nodes terminated and parked this pass. */
  stopped: number;
}

/** The providers that publish a graph progress signal at all. */
function isCheckedNode(row: RunningNodeRunActivity): boolean {
  if (row.provider === 'opencode2') return true;
  // A claude node only reports on the host; a sandboxed run has no signal.
  return row.provider === 'claude' && (row.placement === null || row.placement === 'host');
}

/**
 * Why a termination does not prove the session dead. `undefined` means the
 * kill is attributable and was delivered (`dead`/`foreign` are proofs too).
 */
function refusalOf(proof: TerminationProof | undefined): string | null {
  if (proof === undefined) return 'no session found in this window';
  if (proof.kind === 'unknown') return 'termination proof unknown';
  if (proof.kind === 'attributable' && proof.kill !== 'killed') {
    return `attributable kill ${proof.kill}`;
  }
  return null;
}

/**
 * Stop and park every eligible node of one graph run that has shown no session
 * activity within the awake limit. Idempotent: a node already parked, or moved
 * by another window, is a no-op in `parkLaunchFailure`.
 */
export async function runFirstActivityWatchdog(
  deps: FirstActivityWatchdogDeps,
  graphRunId: number,
): Promise<FirstActivityWatchdogResult> {
  const rows = runningNodeRunsForFirstActivity(deps.db, graphRunId);
  const nowMs = Date.parse(deps.now());
  const result: FirstActivityWatchdogResult = { checked: rows.length, stopped: 0 };

  for (const row of rows) {
    if (!isCheckedNode(row)) continue;
    if (row.hasUsageSample) continue;
    if (row.process_run_id === null || row.started_at === null) continue;
    const startedMs = Date.parse(row.started_at);
    if (!Number.isFinite(startedMs) || !Number.isFinite(nowMs)) continue;
    const awakeMs = deps.awakeElapsedMs(startedMs, nowMs);
    if (!Number.isFinite(awakeMs) || awakeMs < FIRST_ACTIVITY_WAIT_MS) continue;

    let proof: TerminationProof | undefined;
    try {
      proof = await deps.terminateSession({ graphRunId, nodeRunId: row.id });
    } catch (err) {
      // The row stays `running`: without a proven kill it may still be live.
      deps.debug?.(
        `[graph] first-activity watchdog: termination failed for node run ${row.id}, row left running: ${err instanceof Error ? err.message : String(err)}`,
      );
      continue;
    }
    const refusal = refusalOf(proof);
    if (refusal !== null) {
      deps.debug?.(
        `[graph] first-activity watchdog: ${refusal} for node run ${row.id}, row left running`,
      );
      continue;
    }

    const minutes = Math.floor(awakeMs / 60_000);
    const nodeReason = `no session activity ${minutes} min after launch`;
    const runReason = `node-blocked: node run ${row.id} showed no session activity ${minutes} min after launch`;
    // Only the store seam is read for a `node-blocked` park: `withModelDifference`
    // short-circuits on a non-`failed-to-launch` reason before touching the
    // manifest. The cast keeps that narrow seam visible at the one call site.
    parkLaunchFailure(
      {
        db: deps.db,
        transaction: deps.transaction,
        now: deps.now,
        debug: deps.debug,
      } as unknown as GraphDriverDeps,
      graphRunId,
      row.id,
      nodeReason,
      false,
      runReason,
    );
    emitGraphDiagnostic(
      { db: deps.db, debug: deps.debug },
      {
        category: 'block',
        graphRunId,
        nodeRunId: row.id,
        detail: `node run ${row.id} (${row.provider}) showed no session activity ${minutes} min after launch`,
      },
    );
    result.stopped += 1;
  }

  return result;
}
