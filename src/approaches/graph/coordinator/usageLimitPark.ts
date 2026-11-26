/**
 * T1380 — the durable park of a graph node/planner that hit its provider usage
 * limit.
 *
 * The graph run block IS the park (@arch:GRAPH-AUTORECOVERY): no separate
 * `usage_limit_parks` table. ONE `BEGIN IMMEDIATE` transaction compare-and-sets
 * the BOTH rows (`approach_graph_runs` and the role run), records the node's
 * `failure_category = 'usage-limit'` (or the planner's reason/end), blocks the
 * graph run with a `usage-limit:` reason and releases one process slot. Any row
 * that already moved is a no-op — another window won the park.
 *
 * Only AFTER the commit does the host terminate the session, through the graph
 * transport's attributable kill (never a raw pid). A denied or errored kill
 * leaves the committed rows exactly as written: the block is the durable truth,
 * and a live terminal whose kill was refused is reconciled later.
 *
 * Two details the one-shot signal needs: a PARALLEL node of the same stop parks
 * too (the run keeps the first reason; only the first park prompts), and a
 * lock-contended transaction is retried with bounded async backoff, because the
 * coordinator connection runs with `busy_timeout = 0` and no later tick will
 * re-read this signal.
 *
 * Never automatic: `'usage-limit'` is not an `AUTOMATIC_CATEGORIES` member, so
 * the coordinator never relaunches on the same exhausted core. The user picks.
 *
 * Host-agnostic: store, transaction, clock, the termination seam and the log
 * are injected. No vscode, no transport instance, no raw SQL outside the store
 * modules (@arch:GRAPHRUN).
 */

import type { Store } from '../../../store/db.js';
import { getTicket } from '../../../store/tickets.js';
import { recordEvent } from '../../../store/karstEvents.js';
import { casStatus, GRAPH_RUN_TRANSITIONS, GraphStoreError } from '../../../store/graph/transitions.js';
import {
  graphRunById,
  markGraphRunBlocked,
  releaseGraphProcessSlot,
} from '../../../store/graph/graphRuns.js';
import {
  nodeRunById,
  setNodeRunFailure,
  transitionNodeRun,
} from '../../../store/graph/nodeRuns.js';
import {
  plannerRunById,
  setPlannerRunReasonEndedAt,
  transitionPlannerRun,
} from '../../../store/graph/plannerRuns.js';
import { sanitizeInline } from '../../../model/messageText.js';
import { emitGraphDiagnostic } from '../diagnostics.js';
import { LAUNCH_FAILURE_LINE_MAX } from '../driver.js';
import type { TerminationProof } from '../transport/agentTransport.js';

/** One usage-limit signal, as the hook/transcript reader resolved it. */
export interface GraphUsageLimitParkInput {
  graphRunId: number;
  role: 'node' | 'planner';
  /** The node run or planner run id the role names. */
  runId: number;
  provider: string;
  model: string | null;
  /** The provider's own quota text, as read from the hook or transcript. */
  text: string;
}

export type GraphUsageLimitParkResult =
  | {
      parked: true;
      ticketId: number;
      reason: string;
      /** This call blocked the RUN, so it is the one that offers the prompt. A
       *  parallel node of the same stop parks without a second prompt. */
      prompt: boolean;
      termination?: TerminationProof;
    }
  | { parked: false };

export interface GraphUsageLimitParkDeps {
  store: Store;
  /** BEGIN IMMEDIATE-wrapped, all-or-nothing; a throw rolls back. */
  transaction: <T>(fn: () => T) => T;
  now: () => string;
  debug?: (message: string) => void;
  /**
   * Terminate the parked session through the graph transport (`terminate`),
   * AFTER the park commits. An attributable kill only — never a raw pid. The
   * host closes over the live `SupervisedAgentSession`.
   */
  terminateSession?: (target: {
    graphRunId: number;
    role: 'node' | 'planner';
    runId: number;
  }) => Promise<TerminationProof | undefined>;
  /**
   * The async pause between retries of a lock-contended transaction. The
   * coordinator connection runs with `busy_timeout = 0` (a synchronous wait
   * would block the extension host), so a park that meets another writer's
   * lock retries here instead of being dropped (a hook/transcript signal is
   * one-shot). Defaults to a real timer; tests inject a no-op.
   */
  pause?: (ms: number) => Promise<void>;
}

/** The backoff between lock-contention retries: 50+100+200+400+800 ms total. */
const BUSY_RETRY_DELAYS_MS: readonly number[] = [50, 100, 200, 400, 800];

/** A write lock held by another connection (the coordinator has no busy timeout). */
function isLockContention(err: unknown): boolean {
  return (
    err instanceof Error &&
    ((err as { code?: string }).code?.startsWith('SQLITE_BUSY') === true ||
      /database is (locked|busy)/i.test(err.message))
  );
}

function defaultPause(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** The one-line text recorded on the role row: no control characters, capped. */
function sanitizedLine(text: string): string {
  return sanitizeInline(text).trim().slice(0, LAUNCH_FAILURE_LINE_MAX);
}

/** The graph-run block reason every surface reads (`usage-limit: …`). */
function blockReason(input: GraphUsageLimitParkInput, text: string): string {
  return `usage-limit: ${input.role} run ${input.runId} on ${input.provider}/${input.model || 'default'}: ${text}`;
}

/** The debug line a refused/unprovable kill gets — the rows are already written. */
function terminationNote(proof: TerminationProof): string | null {
  if (proof.kind === 'unknown') {
    return '[graph] usage-limit park: termination proof unknown — the block stays, reconcile revisited the session';
  }
  if (proof.kind === 'attributable' && proof.kill === 'denied') {
    return '[graph] usage-limit park: attributable kill denied — the block stays, reconcile revisited the session';
  }
  return null;
}

/** The rows a winning park wrote: the ticket, and whether THIS call blocked the run. */
interface ParkedRows {
  ticketId: number;
  blockedRun: boolean;
}

/** Run the park transaction, retrying a lock-contended write (the coordinator
 *  connection has `busy_timeout = 0`, and the signal is one-shot). */
async function parkRowsWithBusyRetry(
  deps: GraphUsageLimitParkDeps,
  fn: () => ParkedRows | null,
): Promise<ParkedRows | null> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return deps.transaction(fn);
    } catch (err) {
      const delay = BUSY_RETRY_DELAYS_MS[attempt];
      if (delay === undefined || !isLockContention(err)) throw err;
      deps.debug?.(`[graph] usage-limit park: database busy, retrying in ${delay}ms`);
      await (deps.pause ?? defaultPause)(delay);
    }
  }
}

/**
 * Park a running graph node or planner on its provider usage limit. Returns
 * `{ parked: false }` when either row is not in its active running state (a
 * race another window already resolved), mutating nothing.
 */
export async function parkGraphUsageLimit(
  deps: GraphUsageLimitParkDeps,
  input: GraphUsageLimitParkInput,
): Promise<GraphUsageLimitParkResult> {
  const { store } = deps;
  const db = store.db;
  const now = deps.now();
  const text = sanitizedLine(input.text);
  const reason = blockReason(input, text);

  const parked = await parkRowsWithBusyRetry(deps, (): ParkedRows | null => {
    const run = graphRunById(db, input.graphRunId);
    if (!run) return null;

    if (input.role === 'node') {
      const node = nodeRunById(db, input.runId);
      if (!node || node.graph_run_id !== input.graphRunId || node.status !== 'running') return null;
      // A PARALLEL node can hit the same provider stop after the first node
      // already blocked the run. It still parks (blocked + terminated), but
      // the run keeps the first reason and only the first park asks the user.
      const sameStop =
        run.status === 'blocked' && run.blocked_reason?.startsWith('usage-limit') === true;
      if (run.status !== 'running' && !sameStop) return null;
      if (!transitionNodeRun(db, input.runId, 'running', 'blocked')) return null;
      setNodeRunFailure(db, input.runId, {
        failureCategory: 'usage-limit',
        reason: text,
        now,
      });
      if (!sameStop) {
        if (
          !casStatus(db, 'approach_graph_runs', GRAPH_RUN_TRANSITIONS, input.graphRunId, 'running', 'blocked')
        ) {
          // Structurally unreachable under BEGIN IMMEDIATE (the status was read in
          // this transaction); throw so a hypothetical race rolls the node write
          // back instead of committing a half-park.
          throw new GraphStoreError(`usage-limit park: run ${input.graphRunId} left running mid-transaction`);
        }
        markGraphRunBlocked(db, input.graphRunId, reason, now);
      }
      releaseGraphProcessSlot(db, input.graphRunId, now);
      return { ticketId: run.ticket_id, blockedRun: !sameStop };
    }

    // A bootstrap planner runs while the graph run is `planning`; a replan
    // planner runs while it is `draining`. Both are ACTIVE; `blocked`,
    // `closed`, `cancelled` and `stale` are never a live planner's run.
    if (run.status !== 'planning' && run.status !== 'draining') return null;
    const planner = plannerRunById(db, input.runId);
    if (!planner || planner.graph_run_id !== input.graphRunId || planner.status !== 'running') {
      return null;
    }
    // The planner's rest state is `stale` (the crash matrix's abandoned
    // planner shape), never `blocked` — `blocked` is compile-repair waiting.
    if (!transitionPlannerRun(db, input.runId, 'running', 'stale')) return null;
    setPlannerRunReasonEndedAt(db, input.runId, reason, now);
    if (
      !casStatus(db, 'approach_graph_runs', GRAPH_RUN_TRANSITIONS, input.graphRunId, run.status, 'blocked')
    ) {
      throw new GraphStoreError(`usage-limit park: run ${input.graphRunId} left ${run.status} mid-transaction`);
    }

    markGraphRunBlocked(db, input.graphRunId, reason, now);
    releaseGraphProcessSlot(db, input.graphRunId, now);
    return { ticketId: run.ticket_id, blockedRun: true };
  });

  if (parked === null) return { parked: false };
  const { ticketId } = parked;

  // After the commit: terminate through the transport's attributable kill. A
  // refusal or a transport error never undoes the park — the block is truth.
  let termination: TerminationProof | undefined;
  if (deps.terminateSession) {
    try {
      termination = await deps.terminateSession({
        graphRunId: input.graphRunId,
        role: input.role,
        runId: input.runId,
      });
      const note = termination ? terminationNote(termination) : null;
      if (note) deps.debug?.(note);
    } catch (err) {
      deps.debug?.(
        `[graph] usage-limit park: termination failed, the block stays: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  emitGraphDiagnostic({ db, debug: deps.debug }, {
    category: 'block',
    graphRunId: input.graphRunId,
    ...(input.role === 'node' ? { nodeRunId: input.runId } : { plannerRunId: input.runId }),
    detail: reason,
  });

  // One Karst event (@arch:EVENTS): the person-facing outcome, not a debug line.
  const ticket = getTicket(store, ticketId);
  if (ticket.projectId !== null) {
    recordEvent(
      store,
      {
        projectId: ticket.projectId,
        ticketId,
        level: 'warn',
        source: 'host',
        title: `graph run ${input.graphRunId}: ${input.role} parked on ${input.provider} usage limit`,
        body: reason,
      },
      deps.debug ?? (() => {}),
    );
  }

  return { parked: true, ticketId, reason, prompt: parked.blockedRun, ...(termination ? { termination } : {}) };
}
