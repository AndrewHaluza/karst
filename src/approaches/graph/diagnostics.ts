/**
 * Bounded structured diagnostics for graph tickets (Slice 6 Task 3).
 *
 * One opaque, keyed, bounded line per scheduler event, emitted through the
 * INJECTED `debug` callback — this module never imports the logger (pinned by
 * the import-graph test). The full key set — project slug, ticket key, stage
 * attempt, graph run, revision, planner run, node run, generation — is present
 * on every line, so a diagnostic is greppable across tickets and windows.
 *
 * Safety contract (the plan's "Never logged" list):
 *  - `detail` is capped BEFORE it reaches the callback, so an adversarially
 *    long agent/git reason is bounded at the source;
 *  - the RENDERED line then passes through the SAME redaction pipeline
 *    (`sanitizeText`) the diagnostic buffer applies at capture — a secret,
 *    token, or long-credential-shaped capability hash never survives to the
 *    callback, and the emitter never bypasses the pipeline;
 *  - a prompt body, completion capability, or repository contents are NEVER
 *    passed by a call site in the first place: the wired detail is bounded
 *    reason prose (a node id, a refusal category, a git one-liner), and a
 *    prompt is referenced as its hash/length, never its text.
 *
 * Call sites resolve the identity once per run via `resolveGraphDiagnosticIdentity`
 * and hand the emitter `{ db, debug }`; a caller without a store (a transport)
 * injects `identityOf` instead. Unknown runs emit nothing — a diagnostic for a
 * run that no longer exists is noise, not evidence.
 */

import type { GraphDb } from '../../store/graph/transitions.js';
import { sanitizeText } from '../../diagnostics/redact.js';

/** Cap for the free-form detail tail of a diagnostic line. */
export const GRAPH_DIAGNOSTIC_DETAIL_MAX = 200;

/** The closed event categories the graph coordinator covers at V1. */
export type GraphDiagnosticCategory =
  | 'compile'
  | 'claim'
  | 'defer'
  | 'launch'
  | 'completion-rejection'
  | 'integration'
  | 'recovery'
  | 'replan'
  | 'block'
  | 'close';

/** The closed set, in one place — tests iterate it. */
export const GRAPH_DIAGNOSTIC_CATEGORIES: readonly GraphDiagnosticCategory[] = [
  'compile',
  'claim',
  'defer',
  'launch',
  'completion-rejection',
  'integration',
  'recovery',
  'replan',
  'block',
  'close',
] as const;

/** The ticket-side identity of a graph run — resolved once per run. */
export interface GraphDiagnosticIdentity {
  /** The project slug; null for a ticket never bound to a project. */
  project: string | null;
  /** The ticket key. */
  ticket: string | null;
  /** The impl stage attempt the run belongs to. */
  stageAttempt: number | null;
}

/** The complete key set of one diagnostic line. */
export interface GraphDiagnosticKeys extends GraphDiagnosticIdentity {
  graphRunId: number;
  revisionId: number | null;
  plannerRunId: number | null;
  nodeRunId: number | null;
  generation: string | null;
}

/** One event to report: the category, the run the line is keyed by, and the
 *  optional bounded detail. Absent keys render as `null`, never as dropped
 *  fields — a line always carries its full shape. */
export interface GraphDiagnosticEvent {
  category: GraphDiagnosticCategory;
  graphRunId: number;
  revisionId?: number | null;
  plannerRunId?: number | null;
  nodeRunId?: number | null;
  generation?: string | null;
  detail?: string;
}

export interface GraphDiagnosticDeps {
  /** The store the run identity is read from. A caller without a store (a
   *  transport) injects `identityOf` instead. */
  db?: GraphDb;
  /** Alternative identity resolution for a caller without a store. */
  identityOf?: (graphRunId: number) => GraphDiagnosticIdentity | undefined;
  /** The injected debug callback — the HOST binds it to `logger.debug`. */
  debug?: (message: string) => void;
}

/** Read the run's identity — project slug, ticket key, stage attempt — from
 *  the graph run + ticket + project rows. Undefined when the run is gone. */
export function resolveGraphDiagnosticIdentity(
  db: GraphDb,
  graphRunId: number,
): GraphDiagnosticIdentity | undefined {
  const row = db
    .prepare(
      `SELECT g.stage_attempt AS stageAttempt, t.key AS ticket, p.slug AS project
         FROM approach_graph_runs g
         JOIN tickets t ON t.id = g.ticket_id
         LEFT JOIN projects p ON p.id = t.project_id
        WHERE g.id = ?`,
    )
    .get(graphRunId) as
    | { stageAttempt: number; ticket: string | null; project: string | null }
    | undefined;
  if (!row) return undefined;
  return { project: row.project ?? null, ticket: row.ticket ?? null, stageAttempt: row.stageAttempt };
}

/** Collapse whitespace/control chars and cap the detail BEFORE it reaches a
 *  callback — the "bounded before it reaches a debug line" contract. */
function boundedDetail(raw: string): string {
  return raw
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, GRAPH_DIAGNOSTIC_DETAIL_MAX);
}

/** Render ONE bounded line with the full key set. Pure — unit-testable. */
export function renderGraphDiagnosticLine(
  keys: GraphDiagnosticKeys,
  category: GraphDiagnosticCategory,
  detail?: string,
): string {
  const tail = detail === undefined || detail.trim() === ''
    ? ''
    : ` ${boundedDetail(detail)}`;
  return `[graph:${category}] project=${keys.project ?? 'null'} ticket=${keys.ticket ?? 'null'} `
    + `attempt=${keys.stageAttempt ?? 'null'} graph=${keys.graphRunId} revision=${keys.revisionId ?? 'null'} `
    + `planner=${keys.plannerRunId ?? 'null'} node=${keys.nodeRunId ?? 'null'} gen=${keys.generation ?? 'null'}${tail}`;
}

/** Emit one structured diagnostic: resolve the run identity, render the
 *  bounded line, push it through the redaction pipeline, and hand it to the
 *  injected `debug` callback. Returns the emitted line, or undefined when the
 *  run is unknown (nothing is emitted for a run that no longer exists). */
export function emitGraphDiagnostic(
  deps: GraphDiagnosticDeps,
  event: GraphDiagnosticEvent,
): string | undefined {
  const identity = deps.db
    ? resolveGraphDiagnosticIdentity(deps.db, event.graphRunId)
    : deps.identityOf?.(event.graphRunId);
  if (!identity) return undefined;
  const line = renderGraphDiagnosticLine(
    {
      ...identity,
      graphRunId: event.graphRunId,
      revisionId: event.revisionId ?? null,
      plannerRunId: event.plannerRunId ?? null,
      nodeRunId: event.nodeRunId ?? null,
      generation: event.generation ?? null,
    },
    event.category,
    event.detail,
  );
  const safe = sanitizeText(line);
  const out = safe.value ?? '[OMITTED:unsafe-log]';
  deps.debug?.(out);
  return out;
}
