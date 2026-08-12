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
 * row's visible status names it. A ready node under `maxParallel: 1`
 * renders an explicit serialized reason row, so deliberate serialization
 * never reads as a scheduler defect.
 *
 * Every graph-derived label, reason, artifact name, and log line passes
 * through `sanitizeGraphText`, the one audited escaper of this module: ANSI
 * and control sequences are removed, unsafe link schemes (javascript:,
 * vbscript:, data:) are removed, whitespace is collapsed, and the result is
 * bounded. The webview CSP stays authoritative on top of that (F9).
 */

import type {
  EvidenceRow,
  InsideProcessView,
  InsideStatus,
  TypedInsideAction,
} from './types.js';
import { bounded } from './bounds.js';

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
  visitNumber: number;
  status: string;
  outcome: string | null;
  reason: string | null;
  provider: string | null;
  model: string | null;
  effort: string | null;
  profile: string | null;
  launchAttempt: number;
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
  | { kind: 'graph-stop' }
  | { kind: 'graph-discard-node'; nodeRunId: number };

export interface GraphInsideInput {
  /** Feature flag: the projection ships inert until Slice 3 enables it. */
  enabled: boolean;
  graphRun: {
    id: number;
    status: string;
    approachId: string;
    stageAttempt: number;
    createdAt: string;
  } | null;
  plannerRuns: GraphPlannerRunView[];
  nodeRuns: GraphNodeRunView[];
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

function graphRunStatus(status: string): InsideStatus {
  switch (status) {
    case 'planning':
    case 'awaiting-confirmation':
    case 'running':
    case 'draining':
      return 'run';
    case 'blocked':
    case 'stale':
      return 'wait';
    case 'completed-awaiting-impl-marker':
    case 'closed':
      return 'pass';
    case 'cancelled':
      return 'note';
    default:
      return 'pending';
  }
}

function plannerStatus(status: string): InsideStatus {
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
}

function revisionStatus(status: string): InsideStatus {
  switch (status) {
    case 'active':
      return 'run';
    case 'completed':
      return 'pass';
    default:
      return 'note';
  }
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
 * live and a drain is a meaningful signal. A closed, blocked, or stale run
 * carries no stop action — Stop never reads as a reset.
 */
const STOPPABLE_RUN_STATUSES: readonly string[] = [
  'planning',
  'awaiting-confirmation',
  'running',
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

/** The single control a node row carries: the discard exit for an ambiguous
 *  run, else Open for a live session, else none. Exactly one — the discard and
 *  the session-open never compete for one action slot. */
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
  return undefined;
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
      `run ${input.graphRun.id} · ${input.graphRun.status} · ${input.graphRun.approachId}`,
    ),
    status: graphRunStatus(input.graphRun.status),
    ...(STOPPABLE_RUN_STATUSES.includes(input.graphRun.status) && input.attach
      ? { action: input.attach({ kind: 'graph-stop' }) }
      : {}),
  });

  for (const planner of input.plannerRuns) {
    rows.push({
      label: `planner ${planner.plannerRunNumber}`,
      detail: sanitizeGraphText(
        `${planner.kind} · ${planner.status} · compile attempt ${planner.compileAttempt}`,
      ),
      status: plannerStatus(planner.status),
    });
  }

  for (const node of input.nodeRuns) {
    const detail = [
      `${node.nodeKind} · ${node.status}`,
      node.provider,
      node.model,
      node.effort,
      node.profile ? `profile ${node.profile}` : null,
      `visit ${node.visitNumber}/${input.execution.maxNodeRuns}`,
      node.outcome,
      node.reason,
    ]
      .filter((part): part is string => part !== null && part !== undefined && part !== '')
      .join(' · ');
    // One control per node row: the discard exit for an ambiguous run (the
    // process may still be running — the row's visible status names it), Open
    // for a live session (it never spawns one), else none.
    const action = nodeRowAction(input, node);
    rows.push({
      label: `node ${sanitizeGraphText(node.nodeId)}`,
      detail: sanitizeGraphText(detail),
      status: nodeRunStatus(node.status),
      ...(action ? { action } : {}),
    });
  }

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
    const waited = Math.max(0, Date.parse(input.now) - Date.parse(deferral.waitSince));
    rows.push({
      label: `deferred ${sanitizeGraphText(deferral.nodeId)}`,
      detail: sanitizeGraphText(
        `${deferral.reason} · waiting ${Math.floor(waited / 1000)}s`,
      ),
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
      status: revisionStatus(input.revision.status),
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
    aggregate: sanitizeGraphText(input.graphRun.status),
    evidence: { kind: 'rows', rows },
  };
}
