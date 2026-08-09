import type { Store } from './db.js';
import { openProcessRun, finishProcessRun } from './processRuns.js';

/**
 * The STABLE implementation run and its provider segments (v28).
 *
 * One run spans the ticket's entire interactive implementation: provider
 * switches and resume/reload cycles all reattach to it, so the timeline reads
 * "this implementation, one unit" instead of a chain of unrelated sessions.
 * The run is opened when the first implementation launch intent is prepared and
 * closed by exactly ONE authority — the explicit `stage impl pass` marker
 * (`completeImplementationRun`, folded into the marker's transition as its
 * premutate). A `SessionEnd` without the marker may INTERRUPT the run
 * (`interruptImplementationRun`) but can never pass it: the no-inference rule
 * holds one level down.
 *
 * Segments are the provider sessions: the first is confirmed by the initial
 * launch's SessionStart, a switch opens a later one and closes the previous,
 * and a resume reattaches the compatible segment. Every confirmed segment is
 * traceable to the exact prepared launch (`launch_intent_id`).
 *
 * `completeImplementationRun` deliberately opens NO transaction of its own: it
 * runs inside the marker's transition transaction, and the marker CLI's
 * `node:sqlite` shim is flat (nested BEGINs are not supported). Everything else
 * here owns its transaction where atomicity requires one.
 */

export type ImplementationRunStatus = 'running' | 'passed' | 'interrupted';
export type ImplementationSegmentStatus = 'pending' | 'running' | 'closed' | 'interrupted';

export interface ImplementationRun {
  id: number;
  ticketId: number;
  /** The canonical `process_runs(stage_key='impl', process_id='session')` row. */
  processRunId: number;
  /** The impl stage's attempt when the run opened. */
  attempt: number;
  status: ImplementationRunStatus;
  startedAt: string;
  endedAt: string | null;
}

export interface ImplementationSegment {
  id: number;
  implementationRunId: number;
  provider: string;
  model: string | null;
  providerSessionId: string | null;
  /** NULL for the first segment; 'switch' | 'resume' for later ones. */
  reason: string | null;
  status: ImplementationSegmentStatus;
  /** The session_launch_intents row that produced this segment. */
  launchIntentId: number;
  startedAt: string | null;
  endedAt: string | null;
}

export interface ImplementationTimeline {
  run: ImplementationRun;
  segments: ImplementationSegment[];
}

interface ImplementationRunRow {
  id: number;
  ticket_id: number;
  process_run_id: number;
  attempt: number;
  status: string;
  started_at: string;
  ended_at: string | null;
}

interface ImplementationSegmentRow {
  id: number;
  implementation_run_id: number;
  provider: string;
  model: string | null;
  provider_session_id: string | null;
  reason: string | null;
  status: string;
  launch_intent_id: number;
  started_at: string | null;
  ended_at: string | null;
}

const RUN_SELECT =
  `SELECT id, ticket_id, process_run_id, attempt, status, started_at, ended_at
     FROM implementation_runs`;

const SEGMENT_SELECT =
  `SELECT id, implementation_run_id, provider, model, provider_session_id, reason,
          status, launch_intent_id, started_at, ended_at
     FROM implementation_segments`;

function rowToRun(r: ImplementationRunRow): ImplementationRun {
  return {
    id: r.id,
    ticketId: r.ticket_id,
    processRunId: r.process_run_id,
    attempt: r.attempt,
    status: r.status as ImplementationRunStatus,
    startedAt: r.started_at,
    endedAt: r.ended_at,
  };
}

function rowToSegment(r: ImplementationSegmentRow): ImplementationSegment {
  return {
    id: r.id,
    implementationRunId: r.implementation_run_id,
    provider: r.provider,
    model: r.model,
    providerSessionId: r.provider_session_id,
    reason: r.reason,
    status: r.status as ImplementationSegmentStatus,
    launchIntentId: r.launch_intent_id,
    startedAt: r.started_at,
    endedAt: r.ended_at,
  };
}

function runById(store: Store, id: number): ImplementationRun | undefined {
  const row = store.db.prepare(`${RUN_SELECT} WHERE id = ?`).get(id) as
    | ImplementationRunRow
    | undefined;
  return row === undefined ? undefined : rowToRun(row);
}

/** The run the ticket's implementation is (or was last) happening in. */
export function currentImplementationRun(
  store: Store,
  ticketId: number,
): ImplementationRun | undefined {
  const row = store.db
    .prepare(`${RUN_SELECT} WHERE ticket_id = ? ORDER BY id DESC LIMIT 1`)
    .get(ticketId) as ImplementationRunRow | undefined;
  return row === undefined ? undefined : rowToRun(row);
}

/** A run that is still (or again) the ticket's live implementation. */
function openRunForTicket(store: Store, ticketId: number): ImplementationRun | undefined {
  const row = store.db
    .prepare(
      `${RUN_SELECT} WHERE ticket_id = ? AND status IN ('running','interrupted')
        ORDER BY id DESC LIMIT 1`,
    )
    .get(ticketId) as ImplementationRunRow | undefined;
  return row === undefined ? undefined : rowToRun(row);
}

export interface OpenImplementationRunInput {
  ticketId: number;
  attempt: number;
  provider: string;
  model?: string | null;
  startedAt: string;
}

/**
 * Open a run and its canonical `process_runs('impl', 'session')` row. The
 * Session process run is what the marker closes, so the run's lifecycle and the
 * process run's are one fact, and `process_run_id` is UNIQUE to keep it so.
 *
 * Opening does NOT create a segment: a prepared launch is not a started
 * provider session, and a terminal-creation failure must leave the timeline
 * with no segment at all. The first segment is confirmed when the launch's
 * SessionStart arrives.
 */
export function openImplementationRun(store: Store, input: OpenImplementationRunInput): ImplementationRun {
  const processRun = openProcessRun(store, {
    ticketId: input.ticketId,
    stageKey: 'impl',
    processId: 'session',
    attempt: input.attempt,
    provider: input.provider,
    model: input.model ?? null,
    startedAt: input.startedAt,
  });
  const info = store.db
    .prepare(
      `INSERT INTO implementation_runs (ticket_id, process_run_id, attempt, status, started_at, ended_at)
       VALUES (?, ?, ?, 'running', ?, NULL)`,
    )
    .run(input.ticketId, processRun.id, input.attempt, input.startedAt);
  const run = runById(store, Number(info.lastInsertRowid));
  if (run === undefined) throw new Error('implementation run insert did not land');
  return run;
}

export interface OpenImplementationSegmentInput {
  implementationRunId: number;
  provider: string;
  model?: string | null;
  /** NULL for the first segment; 'switch' | 'resume' for later ones. */
  reason?: string | null;
  /** The session_launch_intents row this segment is being confirmed for. */
  launchIntentId: number;
  startedAt?: string | null;
}

/** Open a pending segment. `launch_intent_id` is UNIQUE: one segment per start. */
export function openImplementationSegment(
  store: Store,
  input: OpenImplementationSegmentInput,
): ImplementationSegment {
  const info = store.db
    .prepare(
      `INSERT INTO implementation_segments
         (implementation_run_id, provider, model, provider_session_id, reason, status,
          launch_intent_id, started_at, ended_at)
       VALUES (?, ?, ?, NULL, ?, 'pending', ?, ?, NULL)`,
    )
    .run(
      input.implementationRunId,
      input.provider,
      input.model ?? null,
      input.reason ?? null,
      input.launchIntentId,
      input.startedAt ?? null,
    );
  const row = store.db
    .prepare(`${SEGMENT_SELECT} WHERE id = ?`)
    .get(Number(info.lastInsertRowid)) as ImplementationSegmentRow | undefined;
  if (row === undefined) throw new Error('implementation segment insert did not land');
  return rowToSegment(row);
}

export interface ConfirmImplementationSegmentInput {
  segmentId: number;
  providerSessionId: string;
  /** The confirmation stamp; also the segment's start when it had none. */
  at: string;
}

/**
 * Confirm a pending segment: attach the provider session id and mark it
 * running. A segment confirms exactly once — a second confirm is a no-op, so
 * two starts can never claim the same segment.
 */
export function confirmImplementationSegment(
  store: Store,
  input: ConfirmImplementationSegmentInput,
): boolean {
  const info = store.db
    .prepare(
      `UPDATE implementation_segments
          SET status = 'running',
              provider_session_id = ?,
              started_at = COALESCE(started_at, ?)
        WHERE id = ? AND status = 'pending'`,
    )
    .run(input.providerSessionId, input.at, input.segmentId);
  return info.changes > 0;
}

/** Close a running segment (a switch's predecessor). No-op unless running. */
export function closeImplementationSegment(store: Store, segmentId: number, at: string): boolean {
  const info = store.db
    .prepare(
      `UPDATE implementation_segments SET status = 'closed', ended_at = ?
        WHERE id = ? AND status = 'running'`,
    )
    .run(at, segmentId);
  return info.changes > 0;
}

/**
 * Mark the ticket's running implementation run PASSED and close its active
 * segment and Session process run.
 *
 * The ONLY completion authority is the explicit marker: this runs as the
 * `transition` premutate, inside the marker's transaction, so the run's pass
 * and the stage's advance commit together or not at all. It opens no
 * transaction of its own for exactly that reason (the marker CLI's flat
 * `node:sqlite` shim cannot nest BEGINs). No-op when nothing is running.
 */
export function completeImplementationRun(store: Store, ticketId: number, endedAt: string): void {
  const run = openRunForTicket(store, ticketId);
  if (run === undefined) return;
  store.db
    .prepare(
      `UPDATE implementation_segments SET status = 'closed', ended_at = ?
        WHERE implementation_run_id = ? AND status = 'running'`,
    )
    .run(endedAt, run.id);
  store.db
    .prepare(
      `UPDATE implementation_runs SET status = 'passed', ended_at = ?
        WHERE id = ? AND status = 'running'`,
    )
    .run(endedAt, run.id);
  finishProcessRun(store, run.processRunId, 'passed', endedAt);
}

/**
 * Interrupt the ticket's running implementation run — the honest reading of a
 * session that ended without the marker. NEVER a pass: the run's verdict stays
 * the marker's alone. No-op (returns false) when no run is running.
 */
export function interruptImplementationRun(store: Store, ticketId: number, at: string): boolean {
  const row = store.db
    .prepare(
      `${RUN_SELECT} WHERE ticket_id = ? AND status = 'running' ORDER BY id DESC LIMIT 1`,
    )
    .get(ticketId) as ImplementationRunRow | undefined;
  if (row === undefined) return false;
  const run = rowToRun(row);
  const apply = store.db.transaction(() => {
    store.db
      .prepare(
        `UPDATE implementation_runs SET status = 'interrupted', ended_at = ?
          WHERE id = ? AND status = 'running'`,
      )
      .run(at, run.id);
    store.db
      .prepare(
        `UPDATE implementation_segments SET status = 'interrupted', ended_at = ?
          WHERE implementation_run_id = ? AND status = 'running'`,
      )
      .run(at, run.id);
    finishProcessRun(store, run.processRunId, 'interrupted', at);
  });
  apply();
  return true;
}

/** The ticket's latest run with its segments, oldest segment first. */
export function listImplementationTimeline(
  store: Store,
  ticketId: number,
): ImplementationTimeline | null {
  const run = currentImplementationRun(store, ticketId);
  if (run === undefined) return null;
  const segments = store.db
    .prepare(`${SEGMENT_SELECT} WHERE implementation_run_id = ? ORDER BY id`)
    .all(run.id)
    .map((r) => rowToSegment(r as ImplementationSegmentRow));
  return { run, segments };
}

/**
 * One `token_usage` row attributed to a segment. Written by the interactive
 * usage seam (`store/interactiveUsageSamples.ts`, `estimated = 0` — a measured
 * delta, never a synthesized spend) when the provider's bridge can emit one.
 */
export interface SegmentTokenRow {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  /** 1 = the counts are an estimate, not a report. */
  estimated: number;
  outcome: string;
}

export interface SegmentTokenSummary {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  estimatedCalls: number;
  erroredCalls: number;
}

/**
 * Reduce a segment's measured usage. A segment with NO measured rows returns
 * null — the reducer OMITS tokens rather than reporting a total of 0, because a
 * zero reads as a measured free call and no measurement happened.
 */
export function summarizeSegmentTokens(
  rows: readonly SegmentTokenRow[],
): SegmentTokenSummary | null {
  if (rows.length === 0) return null;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let totalTokens = 0;
  let estimatedCalls = 0;
  let erroredCalls = 0;
  for (const row of rows) {
    inputTokens += row.inputTokens;
    outputTokens += row.outputTokens;
    cacheReadTokens += row.cacheReadTokens;
    cacheWriteTokens += row.cacheWriteTokens;
    totalTokens += row.totalTokens;
    estimatedCalls += row.estimated;
    if (row.outcome === 'error') erroredCalls += 1;
  }
  return {
    calls: rows.length,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    totalTokens,
    estimatedCalls,
    erroredCalls,
  };
}

/** One segment's measured totals — the summarizer's output, per segment. */
export interface SegmentTokenTotals extends SegmentTokenSummary {
  /** The segment these totals belong to. */
  implementationSegmentId: number;
}

interface SegmentTotalsRow {
  implementation_segment_id: number;
  calls: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  total_tokens: number;
  errored_calls: number;
}

/**
 * One measured total per segment of a run, straight from the ledger.
 *
 * This is the SQL feeding path for `summarizeSegmentTokens`'s contract: a
 * single GROUP BY over `implementation_segment_id` answers the same five token
 * sums the reducer would, plus the group's call and error counts (a grouped
 * row cannot carry per-row `outcome`, so those come from COUNT/CASE in the
 * same query). `estimated = 0` is a WHERE clause, not a SUM condition — an
 * estimate is not measured spend, and `estimatedCalls` is 0 by construction
 * because no estimated row can be in a group. A segment with no measured rows
 * has no group and appears nowhere.
 */
export function readSegmentTokenTotals(
  store: Store,
  implementationRunId: number,
): SegmentTokenTotals[] {
  const rows = store.db
    .prepare(
      `SELECT implementation_segment_id,
              COUNT(*) AS calls,
              SUM(input_tokens) AS input_tokens,
              SUM(output_tokens) AS output_tokens,
              SUM(cache_read_tokens) AS cache_read_tokens,
              SUM(cache_write_tokens) AS cache_write_tokens,
              SUM(total_tokens) AS total_tokens,
              SUM(CASE WHEN outcome = 'error' THEN 1 ELSE 0 END) AS errored_calls
         FROM token_usage
        WHERE estimated = 0
          AND implementation_segment_id IN (
                SELECT id FROM implementation_segments WHERE implementation_run_id = ?
              )
        GROUP BY implementation_segment_id
        ORDER BY implementation_segment_id`,
    )
    .all(implementationRunId) as SegmentTotalsRow[];
  return rows.map((row) => ({
    implementationSegmentId: row.implementation_segment_id,
    calls: row.calls,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    cacheReadTokens: row.cache_read_tokens,
    cacheWriteTokens: row.cache_write_tokens,
    totalTokens: row.total_tokens,
    estimatedCalls: 0,
    erroredCalls: row.errored_calls,
  }));
}
