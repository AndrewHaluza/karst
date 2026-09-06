/**
 * Read-only Inside projection for the graph runtime (Slice 2 Task 10, Slice 3
 * Task 11 controls).
 *
 * A pure function of persisted rows — graph run, revision, planner runs,
 * node runs, compile diagnostics, and the artifact list — rendered as ONE
 * process in the impl strip, with the detail rows as its evidence. It is
 * behind a feature flag (`enabled`): with the flag off or no graph run the
 * projection is null.
 *
 * Controls ride the same opaque typed-action seam every inside process uses:
 * a row's `action` is minted through the injected `attach` closure (absent →
 * no actions). Open focuses a live planner/node session (never spawns one);
 * Stop signals the coordinator to drain. An ambiguous node run
 * (`launch-unknown`/`termination-unknown`) carries the DANGER discard exit
 * (Slice 4 Task 4) instead of Open — the process may still be running, and the
 * row's visible status names it. An editable agent node (ready / blocked /
 * failed-to-launch) carries the override-edit exit (Slice 6 Task 4) — the
 * store's claim gate is the write's authority, this is only the control. A
 * ready node under `maxParallel: 1` renders an explicit serialized reason row,
 * so deliberate serialization never reads as a scheduler defect.
 *
 * The node runs render as the status-grouped node LIST (Slice 6 Task 4): the
 * flat rows no longer carry them; the structured `evidence.nodes` composition
 * carries each node's group, identity, visit budget, override marker and its
 * single control. Existing overrides are READ from the `overrides` input and
 * rendered as a marker — this projection writes nothing.
 *
 * Every graph-derived label, reason, artifact name, and log line passes
 * through `sanitizeGraphText`, the one audited escaper of this module: ANSI
 * and control sequences are removed, unsafe link schemes (javascript:,
 * vbscript:, data:) are removed, whitespace is collapsed, and the result is
 * bounded. The webview CSP stays authoritative on top of that (F9).
 */

import type {
  EvidenceRow,
  GraphNodeListRow,
  InsideProcessView,
  InsideStatus,
  TypedInsideAction,
} from './types.js';
import { bounded } from './bounds.js';
import { durationBetween, relativeAge, runAge } from './age.js';
import { NODE_OVERRIDE_EDITABLE_STATUSES } from '../../store/graph/nodeRuns.js';
import { LIVE_PLANNER_STATUSES } from '../../store/graph/plannerRuns.js';

/** Cap for graph-derived text after sanitization. */
export const GRAPH_TEXT_MAX = 200;
const MAX_DIAGNOSTIC_ROWS = 8;
const MAX_ARTIFACT_ROWS = 8;
const MAX_DEFERRAL_ROWS = 8;
const MAX_DIAGNOSTIC_LOG_ROWS = 8;

/**
 * The one audited escaper for graph-derived text. Untrusted planner/authored
 * prose may contain anything; the projection renders TEXT, never markup.
 */
export function sanitizeGraphText(raw: string): string {
  return raw
    .replace(/\u001b\[[0-9;]*[A-Za-z]/g, '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/(?:javascript|vbscript|data):/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, GRAPH_TEXT_MAX);
}

export interface GraphPlannerRunView {
  plannerRunNumber: number;
  kind: 'bootstrap' | 'replan';
  status: string;
  compileAttempt: number;
  reason: string | null;
  /** When the planner's session was proven to exist (`launching → running`),
   *  preserved across a compile-repair re-prompt of the same run. */
  startedAt?: string | null;
  /** When its document reached the store — the boundary between "the planner
   *  is thinking" and "the compiler owes an answer". */
  submittedAt?: string | null;
  endedAt?: string | null;
}

export interface GraphRevisionView {
  revisionNumber: number;
  status: string;
  fingerprint: string | null;
}

export interface GraphArtifactView {
  artifactId: string;
  byteSize: number;
  mediaType: string;
  createdAt: string;
}

export interface GraphDiagnosticView {
  code: string;
  where: string;
  message: string;
}

export interface GraphNodeRunView {
  nodeRunId: number;
  nodeId: string;
  nodeKind: string;
  /** The revision this run was claimed under — overrides are scoped to
   *  `(revision, node)`, so a replanned revision N+1 carries none of N's. */
  revisionId: number;
  visitNumber: number;
  status: string;
  outcome: string | null;
  reason: string | null;
  provider: string | null;
  model: string | null;
  effort: string | null;
  profile: string | null;
  launchAttempt: number;
  startedAt?: string | null;
  endedAt?: string | null;
}

/** One existing per-node override (Slice 4 Task 6), READ-ONLY here. The
 *  projection renders an override marker on the node run it applies to and
 *  never writes one — the override write/clear surface is the store's own
 *  claim-gated transaction, reached through the override EDIT control. */
export interface GraphNodeOverrideView {
  revisionId: number;
  nodeId: string;
  /** The closed override kinds present for `(revision, node)`. */
  kinds: readonly string[];
}

/** One deferred node (Slice 5 Task 3): a node that is READY (its token is
 *  pending) but whose activation the scheduler refused — the persisted reason
 *  makes deliberate serialization read as a decision, never a scheduler
 *  defect. The node has no run row yet (it is still waiting to be claimed), so
 *  the deferral is rendered as its own row. */
export interface GraphNodeDeferralView {
  nodeId: string;
  reason: string;
  waitSince: string;
}

/** The execution policy the node rows' visit budgets and serialization read. */
export interface GraphExecutionView {
  maxParallel: number;
  maxNodeRuns: number;
}

/** A session the host has live for this graph run: planner or node run. */
export type GraphLiveSessionView = { kind: 'planner' | 'node'; runId: number };

/**
 * The ticket-less target shape this projection hands to the injected `attach`
 * closure — the host mints the opaque action id and returns the
 * `{actionId, kind}` the row carries (same contract as `InsideEvidenceTarget`).
 */
export type GraphActionTarget =
  | { kind: 'graph-open-session'; session: { kind: 'planner' | 'node'; runId: number } }
  | { kind: 'graph-confirm'; graphRunId: number }
  | { kind: 'graph-stop'; graphRunId: number }
  | { kind: 'graph-resume'; graphRunId: number }
  // H2: restart a run a Stop drained. `draining` is entered for two very
  // different reasons — a replan planner is compiling revision N+1, or Stop
  // halted the run — and only the first has an actor that leaves it. The
  // second is a deliberate halt, so the exit is a deliberate click, never an
  // automatic resume that restarts agents the user just stopped.
  | { kind: 'graph-restart'; graphRunId: number }
  | { kind: 'graph-replan'; graphRunId: number }
  | { kind: 'graph-mark-impl'; graphRunId: number }
  | { kind: 'graph-discard-node'; nodeRunId: number }
  | { kind: 'graph-edit-override'; nodeRunId: number };

export interface GraphInsideInput {
  /** Feature flag: the projection ships inert until Slice 3 enables it. */
  enabled: boolean;
  graphRun: {
    id: number;
    /** The 1-based run ordinal among THIS ticket's graph runs — the display
     *  number. The global row `id` above is the identity; `runNumber` is how
     *  it reads on the strip ("run 1" for a new ticket whatever the DB-wide
     *  autoincrement has reached). */
    runNumber: number;
    status: string;
    approachId: string;
    stageAttempt: number;
    createdAt: string;
  } | null;
  plannerRuns: GraphPlannerRunView[];
  nodeRuns: GraphNodeRunView[];
  /** Existing per-node overrides (Slice 4 Task 6), READ-ONLY — the projection
   *  renders a marker on the node run each override applies to. */
  overrides: GraphNodeOverrideView[];
  /** Ready-but-blocked nodes whose activation the scheduler refused — each
   *  renders its own row with the persisted reason (Slice 5 Task 3). */
  deferrals: GraphNodeDeferralView[];
  execution: GraphExecutionView;
  revision: GraphRevisionView | null;
  diagnostics: GraphDiagnosticView[];
  artifacts: GraphArtifactView[];
  /**
   * The run's structured diagnostic lines (Slice 6 Task 3) — the "Copy
   * diagnostic" / "Open log" surface. Each line is ALREADY bounded and
   * redacted at the source (the graph diagnostics module renders through the
   * same redaction pipeline the diagnostic buffer applies at capture); the
   * projection re-escapes and bounds every line through `sanitizeGraphText`,
   * so completion capabilities, prompt/completion text, secrets, and
   * unredacted command output can never reach the copied/logged content.
   * Absent → no log section.
   */
  diagnosticLog?: readonly string[];
  /** Sessions the host has live, keyed by run row id. */
  liveSessions: GraphLiveSessionView[];
  /**
   * The host's attach closure for this snapshot (Slice 3 Task 11). Absent →
   * rows carry no actions. A row's action is minted ONLY when a live session
   * backs it: Open reveals a terminal, it never spawns one.
   */
  attach?: (target: GraphActionTarget) => TypedInsideAction | undefined;
  now: string;
}

/**
 * The closed graph-run status vocabulary — mirrors the `approach_graph_runs`
 * CHECK constraint (`schema.sql`) exactly. This is the ONE place a graph-run
 * status is turned into English: the webview must never parse or prettify a
 * status string itself.
 */
const GRAPH_RUN_STATUSES = [
  'planning',
  'awaiting-confirmation',
  'running',
  'draining',
  'blocked',
  'completed-awaiting-impl-marker',
  'closed',
  'stale',
  'cancelled',
] as const;

export type GraphRunStatus = (typeof GRAPH_RUN_STATUSES)[number];

function isGraphRunStatus(status: string): status is GraphRunStatus {
  return (GRAPH_RUN_STATUSES as readonly string[]).includes(status);
}

/**
 * Host-worded copy for every graph-run status — exhaustive over
 * `GraphRunStatus`, so a status added to the schema's CHECK constraint
 * without a case here is a compile error (the `never` branch), not a leaked
 * enum key reaching the panel.
 */
export function graphRunStatusLabel(status: GraphRunStatus): string {
  switch (status) {
    case 'planning':
      return 'Planning';
    case 'awaiting-confirmation':
      return 'Awaiting confirmation';
    case 'running':
      return 'Running';
    case 'draining':
      return 'Draining';
    case 'blocked':
      return 'Blocked';
    case 'completed-awaiting-impl-marker':
      return 'Completed — awaiting implementation marker';
    case 'closed':
      return 'Closed';
    case 'stale':
      return 'Stale';
    case 'cancelled':
      return 'Cancelled';
    default: {
      const unreachable: never = status;
      throw new Error(`unhandled graph run status: ${String(unreachable)}`);
    }
  }
}

/** Host-worded copy for a raw, possibly-stale status string read back from
 *  the store: an unrecognized value (a status this build predates) falls
 *  back to the raw key rather than throwing — the panel must never crash on
 *  evidence written by a newer build. */
function graphRunStatusCopy(status: string): string {
  return isGraphRunStatus(status) ? graphRunStatusLabel(status) : status;
}

function graphRunStatus(status: string): InsideStatus {
  switch (status) {
    case 'planning':
    case 'awaiting-confirmation':
    case 'running':
    case 'draining':
      return 'run';
    case 'blocked':
    case 'stale':
      // The graph's own work is done, but nothing advances until a human or
      // agent fires `karst stage impl pass` — the same "asked nothing is
      // never green" / `awaiting-merge` shape as ship's post-pass wait, never
      // the `closed` bucket below.
    case 'completed-awaiting-impl-marker':
      return 'wait';
    case 'closed':
      return 'pass';
    case 'cancelled':
      return 'note';
    default:
      return 'pending';
  }
}

/**
 * The graph-run statuses in which SOMETHING is still scheduled to advance the
 * run's planner and revision rows. Outside these the run is at rest: no
 * planner session is live, and the recovery exits (Resume, Replan) open NEW
 * planner runs rather than moving the existing ones.
 */
const ADVANCING_GRAPH_RUN_STATUSES: ReadonlySet<string> = new Set([
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
 */
function clampToRunOutcome(status: InsideStatus, runStatus: string): InsideStatus {
  if (status !== 'run' || ADVANCING_GRAPH_RUN_STATUSES.has(runStatus)) return status;
  if (runStatus === 'closed') return 'pass';
  if (runStatus === 'cancelled' || runStatus === 'stale') return 'note';
  return 'wait';
}

function plannerStatus(status: string, runStatus: string): InsideStatus {
  const raw = ((): InsideStatus => {
    switch (status) {
      case 'ready':
        return 'pending';
      case 'launching':
      case 'running':
      case 'submitted':
        return 'run';
      case 'blocked':
      case 'launch-unknown':
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

function revisionStatus(status: string, runStatus: string): InsideStatus {
  const raw = ((): InsideStatus => {
    switch (status) {
      case 'active':
        return 'run';
      case 'completed':
        return 'pass';
      default:
        return 'note';
    }
  })();
  return clampToRunOutcome(raw, runStatus);
}

function nodeRunStatus(status: string): InsideStatus {
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

/**
 * The graph-run statuses a Stop action is offered on: the coordinator is
 * live and a drain is a meaningful signal. A blocked run may still have a
 * process the user needs to terminate; Stop leaves that blocked state intact,
 * never reading as a reset or stage transition.
 */
/**
 * H2: a run Stop drained, as opposed to one draining for a replan. `draining`
 * has exactly one productive exit — an accepted replan submission — so a run
 * that entered it without a replan planner (Stop CASes `running → draining`
 * and elects nothing) has no actor that can ever move it. The revision is
 * still `active` in that case, so restarting is a plain `draining → running`:
 * nothing needs recompiling.
 */
function isStopDrained(input: GraphInsideInput): boolean {
  if (input.graphRun?.status !== 'draining') return false;
  // The same closed status set `hasLiveReplanPlanner` reads in SQL — this
  // projection answers it from the rows it was handed, never a second list.
  return !input.plannerRuns.some(
    (planner) =>
      planner.kind === 'replan' &&
      (LIVE_PLANNER_STATUSES as readonly string[]).includes(planner.status),
  );
}

const STOPPABLE_RUN_STATUSES: readonly string[] = [
  'planning',
  'awaiting-confirmation',
  'running',
  'blocked',
] as const;

function hasLiveSession(
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
 * The CLOSED section vocabulary of the status-grouped node list (Slice 6 T4):
 * `active` folds the in-flight statuses, `other` holds whatever is not named
 * (the unknown/fault rest states, which keep their own row verdicts). The
 * order IS the display order — the projection sorts each node run into its
 * group rank so the webview renders a section header on a group change and
 * never sorts.
 */
export const GRAPH_NODE_GROUPS: readonly string[] = [
  'active',
  'ready',
  'resource-waiting',
  'completed',
  'blocked',
  'stale',
  'cancelled',
  'other',
] as const;

const GRAPH_ACTIVE_STATUSES: readonly string[] = [
  'launching',
  'running',
  'completing',
  'integrating',
] as const;

/** The node-run statuses of the `active` section. */
function nodeGroupFor(status: string): string {
  if (GRAPH_ACTIVE_STATUSES.includes(status)) return 'active';
  switch (status) {
    case 'ready':
      return 'ready';
    case 'waiting-resource':
      return 'resource-waiting';
    case 'completed':
      return 'completed';
    case 'blocked':
      return 'blocked';
    case 'stale':
      return 'stale';
    case 'cancelled':
      return 'cancelled';
    default:
      return 'other';
  }
}

/** Sort node runs into display order: group rank, then node run id. */
function byGroup(a: GraphNodeRunView, b: GraphNodeRunView): number {
  const ga = GRAPH_NODE_GROUPS.indexOf(nodeGroupFor(a.status));
  const gb = GRAPH_NODE_GROUPS.indexOf(nodeGroupFor(b.status));
  return ga - gb || a.nodeRunId - b.nodeRunId;
}

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
function nodeRowAction(
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

/** One structured node-list row (Slice 6 T4). Every untrusted string is
 *  escaped and bounded; `group`/`status`/`displayStatus` are closed keys. */
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

function nodeListView(
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
    group: nodeGroupFor(node.status),
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

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * The impl-strip process for a graph ticket. A pure function of persisted
 * rows; null when the flag is off or no graph run exists.
 */
export function graphInsideProcess(
  input: GraphInsideInput | null | undefined,
): InsideProcessView | null {
  if (!input?.enabled || !input.graphRun) return null;
  const rows: EvidenceRow[] = [];

  rows.push({
    label: 'graph',
    detail: sanitizeGraphText(
      `run ${input.graphRun.runNumber} · ${graphRunStatusCopy(input.graphRun.status)} · ${input.graphRun.approachId}` +
        (relativeAge(input.graphRun.createdAt, input.now)
          ? ` · started ${relativeAge(input.graphRun.createdAt, input.now)}`
          : ''),
    ),
    status: graphRunStatus(input.graphRun.status),
    ...(input.attach && input.graphRun.status === 'blocked'
      ? { action: input.attach({ kind: 'graph-resume', graphRunId: input.graphRun.id }) }
      : input.attach && input.graphRun.status === 'awaiting-confirmation'
        ? { action: input.attach({ kind: 'graph-confirm', graphRunId: input.graphRun.id }) }
        : input.attach && input.graphRun.status === 'completed-awaiting-impl-marker'
          ? { action: input.attach({ kind: 'graph-mark-impl', graphRunId: input.graphRun.id }) }
          : input.attach && isStopDrained(input)
            ? { action: input.attach({ kind: 'graph-restart', graphRunId: input.graphRun.id }) }
            : STOPPABLE_RUN_STATUSES.includes(input.graphRun.status) && input.attach
              ? { action: input.attach({ kind: 'graph-stop', graphRunId: input.graphRun.id }) }
              : {}),
  });

  if (input.attach && input.graphRun.status === 'blocked') {
    rows.push({
      label: 'replan',
      detail: 'Start a new graph revision from the recorded failure evidence',
      status: 'wait',
      action: input.attach({ kind: 'graph-replan', graphRunId: input.graphRun.id }),
    });
    rows.push({
      label: 'stop graph',
      detail: 'Terminate any remaining graph sessions without changing the blocked stage',
      status: 'note',
      action: input.attach({ kind: 'graph-stop', graphRunId: input.graphRun.id }),
    });
  }

  for (const planner of input.plannerRuns) {
    // A planner row's age is the answer to "is this session still working, or
    // did it die three hours ago and nothing noticed" — a `submitted` planner
    // that has owed the compiler an answer since yesterday is the exact shape
    // of a stuck run, and it is indistinguishable from a fresh one without it.
    const age = plannerAge(planner, input.now);
    rows.push({
      label: `planner ${planner.plannerRunNumber}`,
      detail: sanitizeGraphText(
        `${planner.kind} · ${planner.status} · compile attempt ${planner.compileAttempt}` +
          (age ? ` · ${age}` : ''),
      ),
      status: plannerStatus(planner.status, input.graphRun.status),
    });
  }

  // Slice 6 Task 4: the node runs render as the status-grouped node list — the
  // node/edge list surface. The list is ORDERED by group then run id, so the
  // webview inserts a section header on a `group` change and concatenates
  // nothing. The flat `rows` carry the node runs NO longer: a node row's
  // single control (open / discard / edit-override) rides the structured row.
  const nodes = [...input.nodeRuns]
    .sort(byGroup)
    .map((node) =>
      nodeListView(node, input.execution, input.overrides, nodeRowAction(input, node), input.now),
    );

  // A ready node under maxParallel 1 is serialized BY POLICY — the explicit
  // reason row keeps deliberate serialization from reading as a scheduler
  // defect (Slice 3 Task 11).
  if (
    input.execution.maxParallel === 1 &&
    input.nodeRuns.some((n) => n.status === 'ready')
  ) {
    rows.push({
      label: 'serialized',
      detail: sanitizeGraphText(
        `maxParallel ${input.execution.maxParallel} — ready nodes run one at a time`,
      ),
      status: 'note',
    });
  }

  // Slice 5 Task 3: each ready-but-blocked node renders its own row with the
  // scheduler's persisted refusal reason, so deliberate serialization never
  // reads as a scheduler defect. The waiting duration comes from the injected
  // clock — display only, never a decision.
  const deferrals = bounded(input.deferrals, MAX_DEFERRAL_ROWS);
  for (const deferral of deferrals.shown) {
    const waited = durationBetween(deferral.waitSince, input.now) ?? '0s';
    rows.push({
      label: `deferred ${sanitizeGraphText(deferral.nodeId)}`,
      detail: sanitizeGraphText(`${deferral.reason} · waiting ${waited}`),
      status: 'wait',
    });
  }
  if (deferrals.remaining > 0) {
    rows.push({
      label: 'deferred nodes',
      detail: `+${deferrals.remaining} more`,
      status: 'note',
    });
  }

  if (input.revision) {
    rows.push({
      label: 'revision',
      detail: sanitizeGraphText(
        `rev ${input.revision.revisionNumber} · ${input.revision.status}` +
          (input.revision.fingerprint ? ` · ${input.revision.fingerprint.slice(0, 12)}` : ''),
      ),
      status: revisionStatus(input.revision.status, input.graphRun.status),
    });
  }

  const diagnostics = bounded(input.diagnostics, MAX_DIAGNOSTIC_ROWS);
  for (const diagnostic of diagnostics.shown) {
    rows.push({
      label: sanitizeGraphText(diagnostic.code),
      detail: sanitizeGraphText(`${diagnostic.where} — ${diagnostic.message}`),
      status: 'fail',
    });
  }
  if (diagnostics.remaining > 0) {
    rows.push({
      label: 'diagnostics',
      detail: `+${diagnostics.remaining} more`,
      status: 'note',
    });
  }

  const artifacts = bounded(input.artifacts, MAX_ARTIFACT_ROWS);
  for (const artifact of artifacts.shown) {
    rows.push({
      label: sanitizeGraphText(artifact.artifactId),
      detail: sanitizeGraphText(`${artifact.mediaType} · ${formatBytes(artifact.byteSize)}`),
      status: 'pass',
    });
  }
  if (artifacts.remaining > 0) {
    rows.push({
      label: 'artifacts',
      detail: `+${artifacts.remaining} more`,
      status: 'note',
    });
  }

  // Slice 6 Task 3: the run's structured diagnostic lines — bounded and
  // redacted at the source, then re-escaped and bounded here. This is the
  // copy/log surface; it renders TEXT only and never invents a line.
  const log = bounded(input.diagnosticLog ?? [], MAX_DIAGNOSTIC_LOG_ROWS);
  for (const line of log.shown) {
    rows.push({ label: 'log', detail: sanitizeGraphText(line), status: 'note' });
  }
  if (log.remaining > 0) {
    rows.push({ label: 'log', detail: `+${log.remaining} more`, status: 'note' });
  }

  return {
    id: 'graph',
    kind: 'graph',
    label: 'Implementation graph',
    status: graphRunStatus(input.graphRun.status),
    aggregate: sanitizeGraphText(graphRunStatusCopy(input.graphRun.status)),
    aggregateTitle: sanitizeGraphText(input.graphRun.status),
    evidence: {
      kind: 'rows',
      rows,
      ...(nodes.length > 0 ? { nodes } : {}),
    },
  };
}
