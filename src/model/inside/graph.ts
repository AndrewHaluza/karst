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
 * Planner runs, node runs and deferred nodes render as ONE chronological
 * LEDGER (Slice 6 Task 4, unified): the flat rows no longer carry them; the
 * structured `evidence.nodes` list is ordered oldest first (no status
 * sections), each entry carrying its identity, visit budget, override marker,
 * produced artifacts and its single control. Existing overrides are READ from the `overrides` input and
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
import { graphDagView, type GraphTopology } from './graphDag.js';
import { sanitizeGraphText, GRAPH_TEXT_MAX } from './graphText.js';
import {
  AMBIGUOUS_NODE_STATUSES,
  NODE_OVERRIDE_EDITABLE,
  clampToRunOutcome,
  deferredListView,
  formatBytes,
  hasLiveSession,
  instantMs,
  nodeListView,
  nodeRowAction,
  plannerListView,
  plannerStatus,
  type LedgerEntry,
} from './graphLedger.js';

export { sanitizeGraphText, GRAPH_TEXT_MAX, AMBIGUOUS_NODE_STATUSES, NODE_OVERRIDE_EDITABLE };
import { durationBetween, relativeAge, runAge } from './age.js';

const MAX_DIAGNOSTIC_ROWS = 8;
const MAX_ARTIFACT_ROWS = 8;
const MAX_DEFERRAL_ROWS = 8;
const MAX_DIAGNOSTIC_LOG_ROWS = 8;

export interface GraphPlannerRunView {
  plannerRunNumber: number;
  /** The planner run's store id — matches a live `planner` session. */
  plannerRunId?: number;
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
  /** The node run that produced it, when attributed. */
  producerNodeRunId?: number;
  /** The planner run (by number) that produced it, when attributed. */
  producerPlannerRunNumber?: number;
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
  /** The active revision's compiled topology (ids + edges), when readable. */
  topology?: GraphTopology;
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
    case 'running':
    case 'draining':
      return 'run';
    // A run parked on a human's confirmation is not working — it is holding a
    // button. UI-R28b assigns "needs attention / paused" the amber pause
    // glyph, which is `wait`; rendering it as `run` spun a graph that had
    // already stopped and was waiting on a person.
    case 'awaiting-confirmation':
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

function revisionStatus(status: string, runStatus: string): InsideStatus {
  const raw = ((): InsideStatus => {
    switch (status) {
      // A revision is the compiled plan version the run executes under — a
      // durable bookkeeping fact, never an actor. It has no outcome of its
      // own, so `active` is a neutral marker and never a spinner or a pass.
      case 'active':
        return 'note';
      case 'completed':
        return 'pass';
      default:
        return 'note';
    }
  })();
  return clampToRunOutcome(raw, runStatus);
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
  // Stop drains the RUN and never touches the revision, so a genuine stopped
  // drain keeps its revision `active`. A run draining FOR a replan has only a
  // `draining` revision (the election drains the revision in the same
  // transaction it drains the run). The revision status is therefore the whole
  // discriminant: a stale/legacy planner row can never make a stopped drain
  // read as mid-replan, and no live replan planner can exist while the
  // revision is active.
  return input.revision?.status === 'active';
}

const STOPPABLE_RUN_STATUSES: readonly string[] = [
  'planning',
  'awaiting-confirmation',
  'running',
  'blocked',
] as const;

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

  // Slice 6 Task 4: the ONE ledger — planner runs, node runs and deferred
  // nodes as entries of `evidence.nodes`, oldest first by instant. An entry
  // with no instant sorts last in input order; the sort is stable.
  const runStatus = input.graphRun.status;
  const deferrals = bounded(input.deferrals, MAX_DEFERRAL_ROWS);
  const entries: LedgerEntry[] = [
    ...input.plannerRuns.map((planner) => ({
      at: planner.startedAt ?? planner.submittedAt ?? null,
      row: plannerListView(planner, input, runStatus),
      plannerRunNumber: planner.plannerRunNumber,
    })),
    ...input.nodeRuns.map((node) => ({
      at: node.startedAt ?? null,
      row: nodeListView(node, input.execution, input.overrides, nodeRowAction(input, node), input.now),
      nodeRunId: node.nodeRunId,
    })),
    ...deferrals.shown.map((deferral) => ({
      at: deferral.waitSince,
      row: deferredListView(deferral, input.now),
    })),
  ];
  const nodes = entries
    .map((entry, index) => ({ entry, index, ms: instantMs(entry.at) }))
    .sort((a, b) => {
      const an = Number.isNaN(a.ms);
      const bn = Number.isNaN(b.ms);
      if (an !== bn) return an ? 1 : -1;
      return (an ? 0 : a.ms - b.ms) || a.index - b.index;
    })
    .map(({ entry }) => entry);

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

  // Slice 5 Task 3: deferred nodes are ledger entries (above); only the bounded remainder is a flat row.
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

  // An artifact rides the ledger entry that produced it; the unattributed
  // (or producer-not-in-ledger) ones stay flat rows, bounded.
  const flatArtifacts: GraphArtifactView[] = [];
  const byNodeRun = new Map<number, LedgerEntry>();
  const byPlannerNumber = new Map<number, LedgerEntry>();
  for (const e of nodes) {
    if (e.nodeRunId !== undefined) byNodeRun.set(e.nodeRunId, e);
    if (e.plannerRunNumber !== undefined) byPlannerNumber.set(e.plannerRunNumber, e);
  }
  const nested = new Map<LedgerEntry, string[]>();
  for (const artifact of input.artifacts) {
    const owner =
      (artifact.producerNodeRunId !== undefined
        ? byNodeRun.get(artifact.producerNodeRunId)
        : undefined) ??
      (artifact.producerPlannerRunNumber !== undefined
        ? byPlannerNumber.get(artifact.producerPlannerRunNumber)
        : undefined);
    if (!owner) {
      flatArtifacts.push(artifact);
      continue;
    }
    nested.set(owner, [
      ...(nested.get(owner) ?? []),
      `${sanitizeGraphText(artifact.artifactId)} · ${formatBytes(artifact.byteSize)}`,
    ]);
  }
  const ledgerRows = nodes.map((e) => {
    const list = nested.get(e);
    if (!list) return e.row;
    const shown = list.slice(0, MAX_ARTIFACT_ROWS);
    const more = list.length - shown.length;
    return { ...e.row, artifacts: more > 0 ? [...shown, `+${more} more`] : shown };
  });
  const artifacts = bounded(flatArtifacts, MAX_ARTIFACT_ROWS);
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
      ...(ledgerRows.length > 0 ? { nodes: ledgerRows } : {}),
      ...(input.topology && input.topology.nodes.length > 0
        ? { dag: graphDagView(input.topology, ledgerRows) }
        : {}),
    },
  };
}
