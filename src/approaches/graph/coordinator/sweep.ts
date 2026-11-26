/**
 * Coordinator sweep (Slice 3 Task 2).
 *
 * A bounded periodic reconciliation re-reads canonical state and claims
 * activations — it never depends on a wake-up, so a completion that
 * committed to the database is always eventually scheduled even when its
 * callback hit a dead port. That is what makes a lost completion wake-up
 * harmless by construction (design, "Coordinator sweep").
 *
 * One tick: re-reads the graph run's status and active revision, re-parses
 * the canonical document, groups pending tokens by (destination, full fork
 * lineage, fork instance) in token order, claims single activations, and
 * fires a join only when its full arrival set is pending. Work is bounded to
 * `MAX_SWEEP_TRANSITIONS` (≤ 100) state transitions per tick. Raced tokens
 * (claimed by another window mid-tick) are skipped, never thrown; an
 * expected partial join firing is a no-op for that group, retried next tick.
 *
 * Host-agnostic: the transaction and clock are injected; no vscode, no
 * provider, no stage machine.
 */

import type { GraphDb } from '../../../store/graph/transitions.js';
import { casStatus, GRAPH_RUN_TRANSITIONS } from '../../../store/graph/transitions.js';
import {
  graphRunStatus,
  markGraphRunBlocked,
  runningGraphRunIdsForProject,
} from '../../../store/graph/graphRuns.js';
import { pendingTokensForRevision, type GraphTokenRow } from '../../../store/graph/tokens.js';
import {
  heldLeasesForScheduler,
  LIVE_NODE_RUN_STATUSES,
  type SchedulerLeaseRow,
} from '../../../store/graph/leases.js';
import {
  activeProcessesOf,
  clearDeferral,
  countNodeRunsInStatusesForGraphRun,
  recordDeferral,
  type BaseHead,
} from '../../../store/graph/nodeRuns.js';
import { claimActivation, claimJoinActivation, GraphClaimError } from './claim.js';
import { handleBudgetRefusal } from './visits.js';
import { joinCorrelationKey } from './lineage.js';
import {
  agingPriority,
  heldLeaseConflict,
  schedulerReady,
  type SchedulerDecision,
  type SchedulerGroup,
  type SchedulerRefusal,
} from './conflicts.js';
import { earliestFaultNodeRun, faultNodeRunReason } from './completion.js';
import { parseGraphDocument, type ApproachNode, type GraphDocument } from '../parse.js';
import type { ActivationDomain } from './leases.js';
import { emitGraphDiagnostic, type GraphDiagnosticCategory, type GraphDiagnosticEvent } from '../diagnostics.js';

/** The per-tick bound: ≤ 100 state transitions (design, "Coordinator sweep"). */
export const MAX_SWEEP_TRANSITIONS = 100;

/**
 * H4 — the deferral ceiling. Bounded aging (`agingPriority`) is the right
 * policy between COMPETING nodes: the longer a node waits, the earlier it is
 * offered. It has no answer for a refusal that can never clear — a
 * `resource-conflict` against a lease held by a node that is itself parked, a
 * `parallel-slot-busy` against a slot nothing will release. Such a node was
 * simply re-deferred on every tick, forever, while the run stayed `running`
 * and looked healthy: no block, no diagnostic after the first, and nothing in
 * the panel saying the node had waited an hour.
 *
 * This is the SHORT ceiling (T1333). A refusal whose every holder is parked,
 * dead, ambiguous, or missing — and a `parallel-slot-busy` with no live node
 * behind the occupied slots — times out after 30 minutes: nothing will release
 * that holder, so the run is sitting dead. A refusal behind a LIVE holder uses
 * `MAX_LIVE_HOLDER_WAIT_MS` instead: an agent node that runs 40 minutes is
 * making progress, and parking the run under it is the false block T1317 hit.
 * A claim that throws after the scheduler admitted it raced another window, so
 * `holderLiveAfterClaimFailure` re-reads the durable facts before deferring.
 *
 * On expiry the run parks `blocked` with the refusal that would not clear,
 * which is recoverable — the reason maps to the `replan` recovery category,
 * and a plan whose resource claims cannot be satisfied is exactly what a new
 * revision is for.
 */
export const MAX_DEFERRAL_WAIT_MS = 30 * 60_000;

/**
 * T1385 — the first-activity ceiling (T1371, T1372). A running opencode2 node,
 * or a claude node on host placement, that has produced NO usage sample this
 * long after its start is stopped and parked: the provider launched but the
 * prompt never reached a session, and nothing else would ever notice. AWAKE
 * time only, so a host sleep is not activity-free work (the same sleep-ledger
 * rule as the stall windows). A false stop of a slow first turn costs exactly
 * one relaunch, so the bound is generous.
 */
export const FIRST_ACTIVITY_WAIT_MS = 10 * 60_000;

/**
 * H4, the LONG ceiling: a deferral behind a live holder (T1333). The holder's
 * node run is `launching`, `running`, `completing` or `integrating` — or a
 * claimed run at `ready`, which is still awaiting its drive and holds its lease
 * and slot until then — so it is still working and releases when it finishes.
 * Waiting is the correct behaviour, and 30 minutes is shorter than a legitimate
 * long agent run (T1317's holder ran ~40 minutes) or a long build.
 *
 * It is still a CEILING, not an exemption: issue H4 requires every deferral to
 * have an upper bound, so a hung agent cannot hold the run for ever. Four
 * hours is a planner default (the user did not choose it) — well past any
 * plausible legitimate run, and finite. Liveness is the owner's durable
 * node-run status (reconcile moves a dead process to `stale` or
 * `termination-unknown`), so the sweep never probes a process. `wait_since`
 * never moves: a holder that leaves the live set after the waiter's 30th
 * minute times out on the very next tick.
 */
export const MAX_LIVE_HOLDER_WAIT_MS = 4 * 60 * 60_000;

export interface SweepDeps {
  db: GraphDb;
  /** BEGIN IMMEDIATE-wrapped, all-or-nothing; a throw rolls back. */
  transaction: <T>(fn: () => T) => T;
  now: () => string;
  debug?: (message: string) => void;
  /**
   * The canonical integration heads observed right before this tick claims
   * activations (Slice 5 Task 1). The HOST captures them from the canonical
   * worktrees and passes them; the sweep stores them on each claimed node run
   * so workspaces clone exactly the state the claim saw. Absent → node runs
   * record no base heads.
   */
  baseHeadsOf?: (graphRunId: number) => readonly BaseHead[];
  /**
   * The physical domains an activation needs (Slice 5 Task 2). The HOST
   * resolves them from the node's declared claims in the active revision; the
   * sweep passes them into each claim, which acquires one `held` lease per
   * domain inside its transaction. A conflicting domain rolls that claim back
   * and the tick defers the group. Absent → claims acquire no leases.
   */
  domainsForActivation?: (input: {
    graphRunId: number;
    revisionId: number;
    nodeId: string;
    nodeKind: 'agent' | 'command' | 'gate';
  }) => readonly ActivationDomain[];
  /**
   * The external-process ceiling for the run (Slice 5 Task 3) — the manifest's
   * `graph.limits.maxParallel`. The HOST resolves it from the run's approach.
   * It feeds the scheduler's pre-claim admission (a claim at the ceiling
   * defers `parallel-slot-busy` with a persisted reason) and each claim's
   * atomic slot reservation. Absent → the tick enforces no ceiling.
   */
  maxParallelOf?: (graphRunId: number) => number | undefined;
  /**
   * Awake time between two wall stamps (T1326): a host sleep is not a wait. The
   * HOST binds it to the sleep ledger; absent (tests, CLI) it is wall time.
   */
  awakeElapsedMs?: (sinceMs: number, nowMs: number) => number;
}

/** The default: the wall time between two stamps, with no sleep taken out. */
const wallElapsedMs = (sinceMs: number, nowMs: number): number => nowMs - sinceMs;

export interface SweepResult {
  graphRunId: number;
  /** Single activations claimed plus joins fired. */
  claimed: number;
  /** Token status changes plus successor inserts. */
  transitions: number;
}

interface RevisionRow {
  id: number;
  canonical_graph: string;
}

interface TokenGroup {
  destination: string;
  forkLineage: string | null;
  forkInstance: number;
  tokens: GraphTokenRow[];
}

function groupPendingTokens(tokens: readonly GraphTokenRow[]): TokenGroup[] {
  const byKey = new Map<string, TokenGroup>();
  const order: string[] = [];
  for (const token of tokens) {
    if (token.destination_end) continue; // END tokens are never claimed
    const destination = token.destination_node_id!;
    const key = joinCorrelationKey(destination, token.fork_lineage, token.fork_instance);
    let group = byKey.get(key);
    if (!group) {
      group = {
        destination,
        forkLineage: token.fork_lineage,
        forkInstance: token.fork_instance,
        tokens: [],
      };
      byKey.set(key, group);
      order.push(key);
    }
    group.tokens.push(token);
  }
  return order.map((key) => byKey.get(key)!);
}

/**
 * One reconciliation tick for one graph run. Re-reads canonical state, then
 * claims until the transition budget is spent. Returns what it moved.
 */
export function runCoordinatorTick(
  deps: SweepDeps,
  opts: { graphRunId: number; maxTransitions?: number },
): SweepResult {
  const maxTransitions = opts.maxTransitions ?? MAX_SWEEP_TRANSITIONS;
  const db = deps.db;
  const result: SweepResult = { graphRunId: opts.graphRunId, claimed: 0, transitions: 0 };

  /** Structured diagnostic for this run, through the injected debug callback. */
  const graphDiag = (
    category: GraphDiagnosticCategory,
    event: Omit<GraphDiagnosticEvent, 'category' | 'graphRunId'>,
  ): string | undefined => {
    return emitGraphDiagnostic({ db, debug: deps.debug }, { category, graphRunId: opts.graphRunId, ...event });
  };

  if (graphRunStatus(db, opts.graphRunId) !== 'running') return result;

  // Slice 5 Task 6: the FIRST fault stops new launches. A faulted node run on
  // a still-running run means a fault path recorded the node without blocking
  // the run (or a concurrent window raced the block): NO new activation is
  // claimed this tick — the run blocks immediately with the EARLIEST fault by
  // durable event order (lowest node-run id), and the already-active nodes'
  // completions keep recording evidence (a completion is never a claim path).
  const earliestFault = earliestFaultNodeRun(db, opts.graphRunId);
  if (earliestFault) {
    const blocked = deps.transaction(() => {
      if (
        !casStatus(db, 'approach_graph_runs', GRAPH_RUN_TRANSITIONS, opts.graphRunId, 'running', 'blocked')
      ) {
        return false; // a racing window already moved the run
      }
      markGraphRunBlocked(db, opts.graphRunId, faultNodeRunReason(earliestFault), deps.now());
      return true;
    });
    graphDiag('block', {
      nodeRunId: earliestFault.id,
      detail: blocked
        ? `first fault (node ${earliestFault.id}) stops new launches — run blocked`
        : `fault node ${earliestFault.id} present but the run already moved`,
    });
    return result;
  }

  const revision = db
    .prepare(
      "SELECT id, canonical_graph FROM approach_graph_revisions WHERE graph_run_id = ? AND status = 'active'",
    )
    .get(opts.graphRunId) as RevisionRow | undefined;
  if (!revision) return result;

  const parsed = parseGraphDocument(revision.canonical_graph);
  if (!parsed.ok) {
    // A committed revision was compile-validated; failing to re-parse is a
    // defect worth a bounded diagnostic, and a tick can safely do nothing.
    deps.debug?.(
      `[graph] run ${opts.graphRunId} revision ${revision.id} failed to re-parse (${parsed.diagnostics[0]?.code ?? 'unknown'})`,
    );
    return result;
  }
  const document = parsed.document;
  const nodesById = new Map(document.nodes.map((n) => [n.id, n]));
  const joinArrivalEdges = new Map<string, string[]>();
  const joinOutgoing = new Map<string, { edgeId: string; destination: string; end: boolean }>();
  for (const node of document.nodes) {
    if (node.kind !== 'join') continue;
    // Arrivals are the branch→join edges — "predecessor equality: incoming
    // edges are exactly the declared branches" is compile-checked, so the
    // join's incoming edges ARE its arrival set.
    joinArrivalEdges.set(
      node.id,
      document.edges.filter((e) => e.to === node.id).map((e) => e.id),
    );
    const outgoing = document.edges.find((e) => e.from === node.id);
    if (outgoing) {
      joinOutgoing.set(node.id, {
        edgeId: outgoing.id,
        destination: outgoing.to === 'END' ? 'END' : outgoing.to,
        end: outgoing.to === 'END',
      });
    }
  }

  const pending = pendingTokensForRevision(db, revision.id);
  const baseHeads = deps.baseHeadsOf?.(opts.graphRunId) ?? [];
  // Slice 5 Task 3: the scheduler reads the durable facts ONCE per tick — the
  // held leases (this run's and any other window's), the run's process count,
  // and the manifest ceiling. Refusals and the deferred set below consult a
  // WORKING copy so work admitted in this tick is seen by later groups.
  const maxParallel = deps.maxParallelOf?.(opts.graphRunId);
  const workingState: {
    heldLeases: SchedulerLeaseRow[];
    activeProcesses: number;
    liveNodeRuns: number;
    ceiling: number;
  } = {
    heldLeases: heldLeasesForScheduler(db),
    activeProcesses: activeProcessesOf(db, opts.graphRunId),
    // T1333: how many node runs of THIS run are live right now — the
    // `parallel-slot-busy` holder-liveness input. Durable status only, no
    // process probe; a freshly claimed run at `ready` counts.
    liveNodeRuns: countNodeRunsInStatusesForGraphRun(db, opts.graphRunId, LIVE_NODE_RUN_STATUSES),
    ceiling: maxParallel ?? Number.MAX_SAFE_INTEGER,
  };
  const waitSinceByNode = new Map(
    (
      db
        .prepare('SELECT node_id, wait_since FROM approach_node_deferrals WHERE revision_id = ?')
        .all(revision.id) as { node_id: string; wait_since: string }[]
    ).map((row) => [row.node_id, row.wait_since]),
  );

  interface PendingEntry {
    group: TokenGroup;
    node: ApproachNode;
    scheduler: SchedulerGroup;
  }
  const entries: PendingEntry[] = [];
  for (const group of groupPendingTokens(pending)) {
    const node = nodesById.get(group.destination) as ApproachNode | undefined;
    if (!node) {
      deps.debug?.(`[graph] run ${opts.graphRunId}: pending token for unknown node ${group.destination}`);
      continue;
    }
    const nodeKind = node.kind === 'agent' ? 'agent' : node.kind === 'command' ? 'command' : 'gate';
    const domains =
      node.kind === 'join'
        ? []
        : (deps.domainsForActivation?.({
            graphRunId: opts.graphRunId,
            revisionId: revision.id,
            nodeId: group.destination,
            nodeKind,
          }) ?? []);
    const dependencyWaiting =
      node.kind === 'join' &&
      (() => {
        const arrivalEdges = joinArrivalEdges.get(node.id) ?? [];
        return !(
          arrivalEdges.length === group.tokens.length
          && arrivalEdges.every((edgeId) => group.tokens.some((t) => t.edge_id === edgeId))
        );
      })();
    const earliest = [...group.tokens].sort(
      (a, b) => a.created_at.localeCompare(b.created_at) || a.id - b.id,
    )[0]!;
    entries.push({
      group,
      node,
      scheduler: {
        destination: group.destination,
        nodeKind: node.kind,
        domains,
        created: earliest.created_at,
        tokenId: earliest.id,
        forkInstance: group.forkInstance,
        forkLineage: group.forkLineage,
        dependencyWaiting,
      },
    });
  }

  // Bounded aging: a node ready-but-blocked past the threshold is preferred
  // over newer narrow work — a wide-resource node cannot starve behind
  // repeatedly regenerated loop work. Order is otherwise creation time then
  // token id (token id breaks one-millisecond ties across windows).
  const ordered = agingPriority(
    entries.map((e) => e.scheduler),
    deps.now(),
    (nodeId) => waitSinceByNode.get(nodeId) ?? null,
  );
  const entryByGroupKey = new Map(
    entries.map((e) => [
      joinCorrelationKey(e.scheduler.destination, e.scheduler.forkLineage, e.scheduler.forkInstance),
      e,
    ]),
  );

  // H4: set once a deferral timed out and parked the run. The tick stops
  // scheduling from wherever it noticed — including the inner token loop,
  // whose `break` only leaves that group.
  let blockedByDeferral = false;

  /** T1333: the holder liveness to record when a claim throws AFTER the
   *  scheduler admitted it. That is a race with another window — a lease or a
   *  process slot landed between this tick's snapshot and the claim — so the
   *  durable facts are re-read instead of trusting the snapshot: a fresh
   *  conflicting lease supplies its holders' liveness, and with no lease
   *  conflict the refusal was the process ceiling, whose holder is a live node
   *  run of this run. Without this the fallback recorded a refusal with no
   *  liveness and false-blocked a healthy run at 30 minutes. */
  const holderLiveAfterClaimFailure = (domains: readonly ActivationDomain[]): boolean => {
    const conflict = heldLeaseConflict(domains, heldLeasesForScheduler(db));
    if (conflict !== null) return conflict.holderLive;
    return countNodeRunsInStatusesForGraphRun(db, opts.graphRunId, LIVE_NODE_RUN_STATUSES) > 0;
  };

  /** Record the deferral, and answer whether this node's wait has run out
   *  (H4) — the caller then stops scheduling, because the run is blocked. */
  const defer = (nodeId: string, refusal: SchedulerRefusal): boolean => {
    const reason =
      refusal.reason === 'resource-conflict'
        ? `resource-conflict: ${refusal.detail}`
        : refusal.reason === 'parallel-slot-busy'
          ? `parallel-slot-busy: ${refusal.detail}`
          : `dependency-waiting: ${refusal.detail}`;
    const now = deps.now();
    const recorded = recordDeferral(db, {
      graphRunId: opts.graphRunId,
      revisionId: revision.id,
      nodeId,
      reason,
      now,
    });
    if (recorded.fresh) {
      graphDiag('defer', {
        revisionId: revision.id,
        detail: `node ${nodeId} deferred (${refusal.reason}) — waiting since ${recorded.waitSince}`,
      });
    }
    // A dependency-waiting join is waiting on its OWN graph's arrivals, not on
    // a resource — its wait ends when its branches do, and timing it out would
    // block a run that is progressing normally.
    if (refusal.reason === 'dependency-waiting') return false;
    // T1333: the ceiling depends on the HOLDER, not only on elapsed time. A
    // live holder keeps the long bound; `wait_since` is untouched either way,
    // so a holder that dies after 30 minutes times out on the next tick.
    // T1326: the wait counts awake time only, so a host sleep is not a wait.
    const limit = refusal.holderLive ? MAX_LIVE_HOLDER_WAIT_MS : MAX_DEFERRAL_WAIT_MS;
    const waited = (deps.awakeElapsedMs ?? wallElapsedMs)(
      Date.parse(recorded.waitSince),
      Date.parse(now),
    );
    if (!Number.isFinite(waited) || waited < limit) return false;
    return blockOnDeferralTimeout(nodeId, reason, waited);
  };

  /** Park the run on a wait that will not end. Mirrors `handleBudgetRefusal`'s
   *  block: CAS from `running` only, reason recorded, diagnostic emitted. A
   *  raced run (already moved) is a no-op, and the tick still stops. */
  const blockOnDeferralTimeout = (nodeId: string, reason: string, waitedMs: number): boolean => {
    const minutes = Math.floor(waitedMs / 60_000);
    const blockedReason = `graph-deferral-timeout: node ${nodeId} waited ${minutes}m — ${reason}`;
    const blocked = deps.transaction(() => {
      if (
        !casStatus(db, 'approach_graph_runs', GRAPH_RUN_TRANSITIONS, opts.graphRunId, 'running', 'blocked')
      ) {
        return false;
      }
      markGraphRunBlocked(db, opts.graphRunId, blockedReason.slice(0, 2000), deps.now());
      return true;
    });
    if (blocked) {
      graphDiag('block', {
        revisionId: revision.id,
        detail: blockedReason,
      });
      deps.debug?.(`[graph] run ${opts.graphRunId}: ${blockedReason}`);
      blockedByDeferral = true;
      return true;
    }
    // The CAS lost: another window moved the run while this tick worked. That
    // is only a reason to stop if the run actually left `running` — a run this
    // tick is still allowed to schedule for must not lose its remaining
    // transitions to a block nobody performed.
    if (graphRunStatus(db, opts.graphRunId) === 'running') {
      deps.debug?.(
        `[graph] run ${opts.graphRunId}: deferral timeout for node ${nodeId} lost its CAS but the run is still running — scheduling continues`,
      );
      return false;
    }
    blockedByDeferral = true;
    return true;
  };

  for (const scheduler of ordered) {
    if (result.transitions >= maxTransitions) break;
    if (blockedByDeferral) break; // the run is no longer running
    const entry = entryByGroupKey.get(
      joinCorrelationKey(scheduler.destination, scheduler.forkLineage, scheduler.forkInstance),
    );
    if (!entry) continue;
    const { group, node } = entry;
    const schedulerState = {
      heldLeases: workingState.heldLeases,
      activeProcesses: workingState.activeProcesses,
      maxParallel: workingState.ceiling,
      liveNodeRuns: workingState.liveNodeRuns,
    };
    const decision = schedulerReady([scheduler], schedulerState)[0]!;
    // Per-node scheduler verdict. A run that "looks healthy but runs nothing"
    // is a stream of refusals with no other trace until a deferral is
    // persisted, and a `dependency-waiting` join persists none at all.
    deps.debug?.(
      decision.admitted
        ? `[graph] run ${opts.graphRunId}: scheduler admitted ${group.destination} (${node.kind})`
        : `[graph] run ${opts.graphRunId}: scheduler refused ${group.destination} (${node.kind}) — ` +
          `${decision.refused?.reason}: ${decision.refused?.detail}`,
    );

    if (node.kind === 'join') {
      if (decision.admitted === false) {
        if (decision.refused?.reason === 'dependency-waiting') {
          // A join waiting on its arrival set is NOT ready and is NEVER
          // reported as resource-blocked — clear any stale deferral instead.
          clearDeferral(db, revision.id, group.destination);
          continue;
        }
        if (defer(group.destination, decision.refused!)) break;
        continue;
      }
      const outgoing = joinOutgoing.get(node.id);
      if (!outgoing) {
        deps.debug?.(`[graph] run ${opts.graphRunId}: join ${node.id} has no outgoing edge`);
        continue;
      }
      const cost = group.tokens.length + 1; // arrivals + successor token
      if (result.transitions + cost > maxTransitions) break;
      try {
        const fired = claimJoinActivation(
          { db, transaction: deps.transaction, now: deps.now },
          {
            tokenIds: group.tokens.map((t) => t.id),
            baseHeads,
            outgoing: {
              edgeId: outgoing.edgeId,
              destinationNodeId: outgoing.destination,
              destinationEnd: outgoing.end,
              forkInstance: group.forkInstance,
              forkLineage: group.tokens[0]!.fork_lineage,
              forkInstanceId: group.tokens[0]!.fork_instance_id,
            },
          },
        );
        if (fired.claimed) {
          graphDiag('claim', {
            revisionId: revision.id,
            nodeRunId: fired.nodeRunId,
            detail: `join ${group.destination} fired`,
          });
          clearDeferral(db, revision.id, group.destination);
          result.claimed += 1;
          result.transitions += cost;
          continue;
        }
        if (fired.reason === 'budget-exhausted') {
          // A join beyond its budget has no failure outcome — the graph
          // blocks with graph-budget-exhausted, never fires partially.
          const refusal = handleBudgetRefusal(
            { db, transaction: deps.transaction, now: deps.now, debug: deps.debug },
            {
              graphRunId: opts.graphRunId,
              revisionId: revision.id,
              nodeId: group.destination,
              nodeKind: 'join',
              tokens: group.tokens,
            },
          );
          result.transitions += 1;
          clearDeferral(db, revision.id, group.destination);
          if (refusal.kind === 'blocked') break;
        }
      } catch (err) {
        if (err instanceof GraphClaimError) {
          // A join firing acquires no domain lease and reserves no process
          // slot, so a refused firing has no live holder behind it: the short
          // ceiling is right and no `holderLive` is needed (T1333).
          if (defer(group.destination, { reason: 'resource-conflict', detail: err.message })) break;
        } else {
          throw err;
        }
      }
      continue;
    }

    if (!decision.admitted) {
      if (defer(group.destination, decision.refused!)) break;
      continue;
    }
    for (const token of group.tokens) {
      if (result.transitions >= maxTransitions) break;
      let outcome;
      try {
        outcome = claimActivation(
          { db, transaction: deps.transaction, now: deps.now },
          {
            tokenId: token.id,
            nodeKind: node.kind === 'agent' ? 'agent' : node.kind === 'command' ? 'command' : 'gate',
            profileIsExpert: node.kind === 'agent' && node.profile === 'expert',
            baseHeads,
            domains: scheduler.domains,
            maxParallel: maxParallel,
          },
        );
      } catch (err) {
        if (err instanceof GraphClaimError) {
          // Slice 5 Task 2/3: a lease-conflicted or ceiling-refused claim
          // aborts and rolls back — a NORMAL serialization state, not a
          // fault. The token stays pending and the group defers, with the
          // reason persisted so Inside can show it. T1333: the deferral's
          // ceiling needs the holder's liveness, re-read because the claim
          // raced this tick's snapshot.
          defer(group.destination, {
            reason: 'resource-conflict',
            detail: err.message,
            holderLive: holderLiveAfterClaimFailure(scheduler.domains),
          });
          graphDiag('claim', {
            revisionId: revision.id,
            detail: `activation for ${group.destination} refused: ${err.message}`,
          });
          break;
        }
        throw err;
      }
      if (outcome.claimed) {
        graphDiag('claim', {
          revisionId: revision.id,
          nodeRunId: outcome.nodeRunId,
          detail: `node ${group.destination} claimed`,
        });
        clearDeferral(db, revision.id, group.destination);
        // The claimed leases enter the working set ONLY once the claim
        // committed — later groups in this tick see them, and a raced or
        // rolled-back claim never leaves a phantom lease behind.
        for (const domain of scheduler.domains) {
          workingState.heldLeases.push({
            physicalDomain: domain.physicalDomain,
            accessMode: domain.accessMode,
            ambiguous: false,
            paths: [...(domain.paths ?? [])],
            // Just claimed in this tick: its node run is live by construction.
            ownerLive: true,
          });
        }
        // Only agent and command claims reserve a process slot — gates and
        // joins spawn nothing (`activeProcessesOf`) — so only they extend the
        // working ceiling, and the live-node count moves with it: a later group
        // in this tick that meets the ceiling is then waiting behind a LIVE
        // process. A gate claim inflates neither (T1333).
        if (node.kind === 'agent' || node.kind === 'command') {
          workingState.activeProcesses += 1;
          workingState.liveNodeRuns += 1;
        }
        result.claimed += 1;
        result.transitions += 1;
        continue;
      }
      if (outcome.reason !== 'budget-exhausted') continue;
      // Slice 4 Task 1: a visit beyond its budget either routes along the
      // node's declared failure edge or blocks the graph — one transaction,
      // never a silent drop. The group's remaining tokens are either
      // cancelled (routed) or stay pending (blocked → Resume re-evaluates).
      const refusal = handleBudgetRefusal(
        { db, transaction: deps.transaction, now: deps.now, debug: deps.debug },
        {
          graphRunId: opts.graphRunId,
          revisionId: revision.id,
          nodeId: group.destination,
          nodeKind: node.kind,
          tokens: group.tokens,
        },
      );
      result.transitions += 1;
      clearDeferral(db, revision.id, group.destination);
      if (refusal.kind === 'blocked') break; // the run is no longer running
      break; // routed: the group's tokens are consumed; stop scheduling it
    }
  }
  return result;
}

/**
 * All graph runs currently eligible for scheduling, scoped to one project
 * (G1a). `approach_graph_runs` has no `project_id` column of its own; the
 * registry DB is shared by every IDE window (`docs/arch/store-and-schema.md`),
 * so an unscoped read here ticks every OTHER project's runs too — a window
 * on project B would then claim activations for project A's graph, and the
 * compile that follows judges A's plan against B's manifest. Scope joins
 * through `ticket_id → tickets.project_id`, the same pattern every other
 * project-scoped store read uses (see `store/tokenUsage.ts`).
 *
 * `store/projects.ts`'s adoption pass backfills every ticket's `project_id`
 * on first project creation, so a live window's `projectId` is never matched
 * against a `NULL` row in practice; scope is required — there is no
 * unscoped caller left after G1a.
 *
 * A PAUSED ticket (`tickets.paused_at` non-null) is excluded here, at the one
 * read the coordinator schedules from: pause must cost nothing, and a graph
 * run is the most expensive thing karst starts on its own. The run row stays
 * `running` — pause is not a stop — so unpausing puts it straight back in this
 * list with no recovery step.
 */
export function activeGraphRunIds(db: GraphDb, scope: { projectId: number }): number[] {
  return runningGraphRunIdsForProject(db, scope.projectId);
}
