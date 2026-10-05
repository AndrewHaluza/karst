/**
 * The graph ledger builders: planner/node/deferred list views and their
 * status readings. Pure; moved out of `graph.ts` unchanged.
 */

import type { GraphNodeListRow, InsideStatus, TypedInsideAction } from './types.js';
import type {
  GraphArtifactView,
  GraphExecutionView,
  GraphInsideInput,
  GraphLiveSessionView,
  GraphNodeDeferralView,
  GraphNodeOverrideView,
  GraphNodeRunView,
  GraphPlannerRunView,
} from './graph.js';
import { durationBetween, relativeAge, runAge } from './age.js';
import { NODE_OVERRIDE_EDITABLE_STATUSES } from '../../store/graph/nodeRuns.js';
import { LIVE_PLANNER_STATUSES } from '../../store/graph/plannerRuns.js';
import { sanitizeGraphText } from './graphText.js';

/**
 * The graph-run statuses in which SOMETHING is still scheduled to advance the
 * run's planner and revision rows. Outside these the run is at rest: no
 * planner session is live, and the recovery exits (Resume, Replan) open NEW
 * planner runs rather than moving the existing ones.
 */
export const ADVANCING_GRAPH_RUN_STATUSES: ReadonlySet<string> = new Set([
  'planning',
  'awaiting-confirmation',
  'running',
  'draining',
]);

/**
 * A planner/revision row's OWN status is a durable historical fact — "the
 * bootstrap planner was submitted", "this is the active revision" — and never
 * gets rewritten once the parent run stops advancing, because there is nothing
 * left to advance it to. Rendered blind to the parent, `submitted`/`active`
 * read `'run'` (a spinner) forever: #352 showed a bootstrap planner and
 * revision still spinning beside a graph the marker had already closed, and
 * the same blindness showed eleven `submitted` planners "processing" beside a
 * `blocked` run whose sessions were all gone.
 *
 * A row under a non-advancing run clamps any 'run' reading to what the run
 * itself reads — `pass` for `closed` (the row's work is what the closed run
 * delivered), `note` for `cancelled`/`stale` (neither ever confirms it), and
 * `wait` for a run at rest that a human still has to answer (`blocked`,
 * `completed-awaiting-impl-marker`), which is the run row's own status.
 *
 * The clamp admits both `run` and `wait` readings, because a `submitted`
 * planner waiting on an answer nobody will give under a run at rest is the
 * same eternal-spinner defect in a quieter glyph. It deliberately does NOT
 * clamp `note`: a cancelled planner must never be rewritten into a pass
 * because the run it belonged to closed. A planner that never delivered
 * (`blocked`, `launch-unknown`) never reaches this clamp at all — see
 * `plannerStatus`.
 */
export function clampToRunOutcome(status: InsideStatus, runStatus: string): InsideStatus {
  if ((status !== 'run' && status !== 'wait') || ADVANCING_GRAPH_RUN_STATUSES.has(runStatus)) {
    return status;
  }
  if (runStatus === 'closed') return 'pass';
  if (runStatus === 'cancelled' || runStatus === 'stale') return 'note';
  return 'wait';
}

export function plannerStatus(status: string, runStatus: string): InsideStatus {
  // A planner that never delivered — `blocked`, or launched with no known
  // result — must not inherit the run's outcome: under a `closed` run the
  // clamp would confirm it with a `pass` for work it never produced. It has
  // always read `wait` (it was never a spinner), and it keeps that reading.
  if (status === 'blocked' || status === 'launch-unknown') return 'wait';
  const raw = ((): InsideStatus => {
    switch (status) {
      case 'ready':
        return 'pending';
      case 'launching':
      case 'running':
        return 'run';
      // `submitted` is the planner's own terminal phase: the session finished
      // and the COMPILER owes the answer (see `plannerAge`, which reports how
      // long the run has waited on that answer). Nothing is executing, so the
      // row waits rather than spins.
      case 'submitted':
        return 'wait';
      case 'cancelled':
      case 'stale':
        return 'note';
      default:
        return 'pending';
    }
  })();
  return clampToRunOutcome(raw, runStatus);
}

export function nodeRunStatus(status: string): InsideStatus {
  switch (status) {
    case 'ready':
    case 'waiting-resource':
      return 'pending';
    case 'launching':
    case 'running':
    case 'completing':
    case 'integrating':
      return 'run';
    case 'completed':
      return 'pass';
    case 'blocked':
    case 'failed-to-launch':
    case 'launch-unknown':
    case 'termination-unknown':
      return 'wait';
    case 'stale':
    case 'cancelled':
      return 'note';
    default:
      return 'pending';
  }
}

export function hasLiveSession(
  liveSessions: GraphLiveSessionView[],
  kind: 'planner' | 'node',
  runId: number,
): boolean {
  return liveSessions.some((s) => s.kind === kind && s.runId === runId);
}

/** The ambiguous node-run statuses that offer the discard exit (Slice 4 Task
 *  4) — the one explicit action for a process whose fate cannot be proven. */
export const AMBIGUOUS_NODE_STATUSES: readonly string[] = [
  'launch-unknown',
  'termination-unknown',
] as const;

/**
 * The node-run statuses whose configuration is still editable — the ONE source
 * of truth is the store's claim gate (`NODE_OVERRIDE_EDITABLE_STATUSES`); the
 * projection's override-edit attach rule reads the same constant, so a control
 * can only ever be minted on a node the store would still accept a write for.
 * Widened to `readonly string[]` here because the attach rule tests a recorded
 * `node.status`, which is a free string.
 */
export const NODE_OVERRIDE_EDITABLE: readonly string[] = NODE_OVERRIDE_EDITABLE_STATUSES;

/**
 * The single control a node row carries: the discard exit for an ambiguous
 * run, else Open for a live session, else the override-edit exit for an
 * editable AGENT node, else none. Exactly one — the discard, the session-open
 * and the override-edit never compete for one action slot, because the status
 * sets they attach on are disjoint (an ambiguous or launched run is never
 * editable). The override-edit is the plan's "per-node overrides for
 * ready/blocked/failed-to-launch agent nodes BEFORE claiming": the store's
 * claim gate (the same closed set) refuses the write once claiming began, so
 * a stale control is a no-op at the store, never a mutation of a frozen
 * launch.
 */
export function nodeRowAction(
  input: Pick<GraphInsideInput, 'attach' | 'liveSessions'>,
  node: GraphNodeRunView,
): TypedInsideAction | undefined {
  if (!input.attach) return undefined;
  if (AMBIGUOUS_NODE_STATUSES.includes(node.status)) {
    return input.attach({ kind: 'graph-discard-node', nodeRunId: node.nodeRunId });
  }
  if (hasLiveSession(input.liveSessions, 'node', node.nodeRunId)) {
    return input.attach({
      kind: 'graph-open-session',
      session: { kind: 'node', runId: node.nodeRunId },
    });
  }
  if (node.nodeKind === 'agent' && NODE_OVERRIDE_EDITABLE.includes(node.status)) {
    return input.attach({ kind: 'graph-edit-override', nodeRunId: node.nodeRunId });
  }
  return undefined;
}

/** The node's pre-joined identity detail — provider · model · effort ·
 *  profile. Every part is untrusted prose, escaped at the caller. */
function nodeIdentityDetail(node: GraphNodeRunView): string {
  return [
    node.provider,
    node.model,
    node.effort,
    node.profile ? `profile ${node.profile}` : null,
  ]
    .filter((part): part is string => part !== null && part !== undefined && part !== '')
    .join(' · ');
}

/** The override kinds that exist for a node's `(revision, node)` pair, if any
 *  — the READ of the `overrides` input; the projection writes nothing. */
function overrideKindsFor(
  overrides: GraphNodeOverrideView[],
  revisionId: number,
  nodeId: string,
): readonly string[] | undefined {
  return overrides.find((o) => o.revisionId === revisionId && o.nodeId === nodeId)?.kinds;
}

/** The node-run statuses in which something is still expected to move the
 *  row. A row in one of these with no `started_at` is proof its session never
 *  existed, which is why `runAge` renders `never started` only for these — the
 *  planner half of the same question is `LIVE_PLANNER_STATUSES`, already the
 *  store's one definition. */
const LIVE_NODE_DISPLAY_STATUSES: readonly string[] = [
  'ready',
  'waiting-resource',
  'launching',
  'running',
  'completing',
  'integrating',
];

/**
 * A planner row's age fragment. `submitted` is its own phase — the planner
 * finished and the COMPILER owes the answer — so a submitted row reports how
 * long the run has been waiting on that answer rather than how long the
 * session ran, which is the number that distinguishes a compile in flight from
 * a run stranded behind one.
 */
function plannerAge(planner: GraphPlannerRunView, now: string): string | null {
  if (!planner.endedAt && planner.submittedAt) {
    const waited = durationBetween(planner.submittedAt, now);
    return waited === null ? null : `submitted ${waited} ago`;
  }
  return runAge(
    { startedAt: planner.startedAt, endedAt: planner.endedAt },
    now,
    { live: (LIVE_PLANNER_STATUSES as readonly string[]).includes(planner.status) },
  );
}

export function nodeListView(
  node: GraphNodeRunView,
  execution: GraphExecutionView,
  overrides: GraphNodeOverrideView[],
  action: TypedInsideAction | undefined,
  now: string,
): GraphNodeListRow {
  const kinds = overrideKindsFor(overrides, node.revisionId, node.nodeId);
  // A node run's `started_at` is stamped when the RUN ROW is created (at
  // `ready`), not at spawn — `createNodeRun` is the writer. So the age answers
  // "how long has this node been the run's concern", which is exactly the
  // number a node stuck at `waiting-resource` or `launching` needs, and it is
  // never later than the spawn it precedes.
  const age = runAge({ startedAt: node.startedAt, endedAt: node.endedAt }, now, {
    live: LIVE_NODE_DISPLAY_STATUSES.includes(node.status),
  });
  return {
    ...(age ? { age: sanitizeGraphText(age) } : {}),
    nodeRunId: node.nodeRunId,
    nodeId: sanitizeGraphText(node.nodeId),
    nodeKind: sanitizeGraphText(node.nodeKind),
    status: sanitizeGraphText(node.status),
    entry: 'node',
    displayStatus: nodeRunStatus(node.status),
    identity: sanitizeGraphText(nodeIdentityDetail(node)),
    visit: sanitizeGraphText(`visit ${node.visitNumber}/${execution.maxNodeRuns}`),
    ...(kinds && kinds.length > 0
      ? { override: sanitizeGraphText(`override ${kinds.join(',')}`) }
      : {}),
    ...(node.outcome ? { outcome: sanitizeGraphText(node.outcome) } : {}),
    ...(node.reason ? { reason: sanitizeGraphText(node.reason) } : {}),
    ...(action ? { action } : {}),
  };
}

/** Epoch ms of a persisted instant; a SQLite `YYYY-MM-DD HH:MM:SS` is UTC.
 *  NaN when absent or unparseable. */
export function instantMs(at: string | null): number {
  if (!at) return NaN;
  const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(at) ? `${at.replace(' ', 'T')}Z` : at;
  return Date.parse(iso);
}

export interface LedgerEntry {
  at: string | null;
  row: GraphNodeListRow;
  nodeRunId?: number;
  plannerRunNumber?: number;
}

export function plannerListView(
  planner: GraphPlannerRunView,
  input: GraphInsideInput,
  runStatus: string,
): GraphNodeListRow {
  const age = plannerAge(planner, input.now);
  const action =
    input.attach &&
    planner.plannerRunId !== undefined &&
    hasLiveSession(input.liveSessions, 'planner', planner.plannerRunId)
      ? input.attach({
          kind: 'graph-open-session',
          session: { kind: 'planner', runId: planner.plannerRunId },
        })
      : undefined;
  return {
    ...(age ? { age: sanitizeGraphText(age) } : {}),
    entry: 'planner',
    nodeId: `planner ${planner.plannerRunNumber}`,
    nodeKind: sanitizeGraphText(planner.kind),
    status: sanitizeGraphText(planner.status),
    displayStatus: plannerStatus(planner.status, runStatus),
    identity: `compile attempt ${planner.compileAttempt}`,
    ...(planner.reason ? { reason: sanitizeGraphText(planner.reason) } : {}),
    ...(action ? { action } : {}),
  };
}

export function deferredListView(deferral: GraphNodeDeferralView, now: string): GraphNodeListRow {
  const waited = durationBetween(deferral.waitSince, now) ?? '0s';
  return {
    age: `waiting ${waited}`,
    entry: 'deferred',
    nodeId: sanitizeGraphText(deferral.nodeId),
    nodeKind: 'node',
    status: 'deferred',
    displayStatus: 'wait',
    identity: '',
    reason: sanitizeGraphText(deferral.reason),
  };
}

export function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}
