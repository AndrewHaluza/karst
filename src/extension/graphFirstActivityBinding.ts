/**
 * T1385 — the host seam of the first-activity watchdog.
 *
 * The runner itself (`runFirstActivityWatchdog`) is host-agnostic; this module
 * binds it to the live coordinator store and the graph transport. The session
 * lookup mirrors `terminateSession` in `graphUsageLimitBinding.ts`: find the
 * session by (graph run, node run), trust the requested role when a
 * re-attached session omits its kind, and terminate through the transport's
 * attributable kill — never a raw pid.
 *
 * `run` never throws: a failure only delays the next coordinator tick, so it is
 * logged and swallowed here instead of escaping into the host tick.
 */

import type { GraphDb } from '../store/graph/transitions.js';
import type {
  SupervisedAgentSession,
  TerminationProof,
} from '../approaches/graph/transport/agentTransport.js';
import {
  runFirstActivityWatchdog,
  type FirstActivityTarget,
  type FirstActivityWatchdogResult,
} from '../approaches/graph/coordinator/firstActivity.js';

/** The transport seam the watchdog terminates through (attributable kill only). */
export interface GraphFirstActivityTransport {
  sessions(): readonly SupervisedAgentSession[];
  terminate(session: SupervisedAgentSession): Promise<TerminationProof>;
}

export interface GraphFirstActivityBindingDeps {
  /** The graph coordinator store; resolved lazily (created after activation). */
  db(): GraphDb | undefined;
  transaction: <T>(fn: () => T) => T;
  now(): string;
  /** The sleep ledger's awake-time read; wall time must never reach here. */
  awakeElapsedMs: (sinceMs: number, nowMs: number) => number;
  /** The live graph transport; resolved lazily (created after the store). */
  transport(): GraphFirstActivityTransport | undefined;
  debug(message: string): void;
  logError(message: string, error: unknown): void;
}

export interface GraphFirstActivityBinding {
  run(graphRunId: number): Promise<FirstActivityWatchdogResult | undefined>;
}

export function createGraphFirstActivityBinding(
  deps: GraphFirstActivityBindingDeps,
): GraphFirstActivityBinding {
  /** Terminate one node's session through the transport's attributable kill. */
  const terminateSession = async (
    target: FirstActivityTarget,
  ): Promise<TerminationProof | undefined> => {
    const transport = deps.transport();
    if (!transport) return undefined;
    const session = transport
      .sessions()
      .find(
        (s) =>
          s.graphRunId === target.graphRunId &&
          s.nodeRunId === target.nodeRunId &&
          (s.runKind ?? 'node') === 'node',
      );
    if (!session) return undefined;
    return transport.terminate(session);
  };

  return {
    async run(graphRunId) {
      const db = deps.db();
      if (!db) return undefined;
      try {
        return await runFirstActivityWatchdog(
          {
            db,
            transaction: deps.transaction,
            now: deps.now,
            debug: deps.debug,
            awakeElapsedMs: deps.awakeElapsedMs,
            terminateSession,
          },
          graphRunId,
        );
      } catch (err) {
        deps.logError(`karst: graph first-activity watchdog failed for run ${graphRunId}`, err);
        return undefined;
      }
    },
  };
}
