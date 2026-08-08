import type { Store } from './db.js';
import type { Severity } from '../manifest/types.js';

/**
 * `uat_findings` (v31) — one row per OBSERVATION the UAT Tester process
 * reported about a ticket's behavior. Evidence/observations ONLY: unlike
 * `gate_runs` (deterministic exit codes) these rows can never pass, fail,
 * transition, or spend a recovery round by themselves — the ordinary UAT gates
 * stay authoritative, and the optional deterministic `uat.testerVerifier`
 * boundary is the sole Tester-specific verdict source.
 *
 * APPEND-ONLY like `review_findings` and for the same reason: an observation
 * is an event produced by one process invocation, and `stages` is overwritten
 * by a retry. `process_run_id` is REQUIRED — an observation that cannot be
 * attributed to a Tester execution is dropped, never stored against an
 * invented one.
 */

/** One recorded Tester observation. */
export interface UatFinding {
  id: number;
  ticketId: number;
  /** The Tester process run that observed it — REQUIRED, never invented. */
  processRunId: number;
  /** The target repo the observation was scoped to; null = not repo-scoped. */
  repo: string | null;
  severity: Severity;
  title: string;
  /** Repo-relative path, validated where the observation is parsed; null = not file-scoped. */
  filePath: string | null;
  /** null = whole file. */
  line: number | null;
  createdAt: string;
}

/** One observation as reported, before it has an id or a timestamp. */
export interface UatFindingInput {
  severity: Severity;
  repo?: string | null;
  file?: string | null;
  line?: number | null;
  title: string;
}

export interface UatFindingBatch {
  ticketId: number;
  /** The Tester process run producing this batch — REQUIRED (see module doc). */
  processRunId: number;
  findings: readonly UatFindingInput[];
  /** Batch stamp shared by every row of the batch. */
  createdAt: string;
}

interface UatFindingRow {
  id: number;
  ticket_id: number;
  process_run_id: number;
  repo: string | null;
  severity: string;
  title: string;
  file_path: string | null;
  line: number | null;
  created_at: string;
}

const SEVERITIES: readonly Severity[] = ['critical', 'high', 'medium', 'low', 'info'];

/**
 * An unrecognized severity degrades to `'info'` rather than throwing — the
 * same boundary `store/reviewFindings.ts`'s `parseSeverity` applies to its own
 * table: a row this cannot parse can only arrive from direct tampering or a
 * future karst's wider vocabulary, and `'info'` is the vocabulary's inert
 * reading — it must not read as something a consumer would act on.
 */
function parseSeverity(raw: string): Severity {
  return SEVERITIES.includes(raw as Severity) ? (raw as Severity) : 'info';
}

function rowToFinding(r: UatFindingRow): UatFinding {
  return {
    id: r.id,
    ticketId: r.ticket_id,
    processRunId: r.process_run_id,
    repo: r.repo,
    severity: parseSeverity(r.severity),
    title: r.title,
    filePath: r.file_path,
    line: r.line,
    createdAt: r.created_at,
  };
}

/**
 * Append one Tester invocation's observations and return their ids (insertion
 * order = report order). Taken as a batch so every row shares `createdAt` and
 * the multi-row insert lands all-or-nothing. An empty batch writes nothing.
 */
export function recordUatFindings(store: Store, batch: UatFindingBatch): number[] {
  if (batch.findings.length === 0) return [];
  const insert = store.db.prepare(
    `INSERT INTO uat_findings (ticket_id, process_run_id, repo, severity, title, file_path, line, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const ids: number[] = [];
  const insertBatch = store.db.transaction((items: readonly UatFindingInput[]) => {
    for (const f of items) {
      const info = insert.run(
        batch.ticketId,
        batch.processRunId,
        f.repo ?? null,
        f.severity,
        f.title,
        f.file ?? null,
        f.line ?? null,
        batch.createdAt,
      );
      ids.push(Number(info.lastInsertRowid));
    }
  });
  insertBatch(batch.findings);
  return ids;
}

/**
 * Every observation ever recorded for a ticket, oldest first (insertion order
 * is report order).
 */
export function listUatFindings(store: Store, ticketId: number): UatFinding[] {
  return store.db
    .prepare(
      `SELECT id, ticket_id, process_run_id, repo, severity, title, file_path, line, created_at
         FROM uat_findings
        WHERE ticket_id = ?
        ORDER BY id`,
    )
    .all(ticketId)
    .map((r) => rowToFinding(r as UatFindingRow));
}

/** One Tester process run's observations, oldest first. */
export function listUatFindingsByProcess(store: Store, processRunId: number): UatFinding[] {
  return store.db
    .prepare(
      `SELECT id, ticket_id, process_run_id, repo, severity, title, file_path, line, created_at
         FROM uat_findings
        WHERE process_run_id = ?
        ORDER BY id`,
    )
    .all(processRunId)
    .map((r) => rowToFinding(r as UatFindingRow));
}

/**
 * One observation by its row id, whatever ticket it belongs to — the
 * typed-action dispatch reloads the row by host-owned id and verifies the
 * ticket itself (`insideActions.ts`).
 */
export function getUatFindingById(store: Store, id: number): UatFinding | undefined {
  const row = store.db
    .prepare(
      `SELECT id, ticket_id, process_run_id, repo, severity, title, file_path, line, created_at
         FROM uat_findings
        WHERE id = ?`,
    )
    .get(id) as UatFindingRow | undefined;
  return row === undefined ? undefined : rowToFinding(row);
}
