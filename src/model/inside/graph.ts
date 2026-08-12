/**
 * Read-only Inside projection for the graph runtime (Slice 2 Task 10).
 *
 * A pure function of persisted rows — graph run, revision, planner runs,
 * compile diagnostics, and the artifact list — rendered as ONE process in the
 * impl strip, with the detail rows as its evidence. NO controls yet, and it
 * is behind a feature flag (`enabled`) so this slice ships inert: with the
 * flag off or no graph run the projection is null.
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
} from './types.js';
import { bounded } from './bounds.js';

/** Cap for graph-derived text after sanitization. */
export const GRAPH_TEXT_MAX = 200;
const MAX_DIAGNOSTIC_ROWS = 8;
const MAX_ARTIFACT_ROWS = 8;

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
  revision: GraphRevisionView | null;
  diagnostics: GraphDiagnosticView[];
  artifacts: GraphArtifactView[];
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

  return {
    id: 'graph',
    kind: 'graph',
    label: 'Implementation graph',
    status: graphRunStatus(input.graphRun.status),
    aggregate: sanitizeGraphText(input.graphRun.status),
    evidence: { kind: 'rows', rows },
  };
}
