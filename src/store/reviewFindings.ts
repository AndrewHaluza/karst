import type { Store } from './db.js';
import type { Severity } from '../manifest/types.js';

/**
 * Who reported a finding. Only `'agent'` is produced today (the review
 * findings lane, a later task); `'human'` is carried in the schema for a
 * manually-added finding, which no code writes yet.
 */
export type FindingSource = 'agent' | 'human';

/**
 * One recorded review finding — structured evidence an agent (or, per the
 * schema, a human) reported about a ticket's diff.
 *
 * `severity` reuses `manifest/types.ts`'s closed `Severity` vocabulary rather
 * than redeclaring it, so the set that `review.findings.blockingSeverity`
 * validates against and the set a finding can carry never drift apart.
 */
export interface Finding {
  id: number;
  ticketId: number;
  /** The stage's attempt when this batch landed. */
  attempt: number;
  /** Batch stamp shared by every finding of one review invocation. */
  runAt: string;
  /**
   * The process_runs row of the review invocation that produced this batch
   * (v27); NULL for a pre-v27 row or a batch whose caller named no process.
   */
  processRunId: number | null;
  severity: Severity;
  /** worktrees.repo; '' when the finding is not repo-scoped. */
  repo: string;
  /** Repo-relative path, validated where the finding is parsed; null = not file-scoped. */
  file: string | null;
  /** null = whole file. */
  line: number | null;
  title: string;
  detail: string;
  source: FindingSource;
  createdAt: string;
}

/** One finding as reported, before it has an id, a batch stamp or an attempt. */
export interface FindingInput {
  severity: Severity;
  repo: string;
  file?: string | null;
  line?: number | null;
  title: string;
  detail: string;
  source: FindingSource;
}

export interface FindingBatch {
  ticketId: number;
  /** The stage's attempt at the moment this batch ran. */
  attempt: number;
  runAt: string;
  /**
   * The process_runs row of the review invocation producing this batch
   * (v27); absent → the batch is recorded unattributed to a process.
   */
  processRunId?: number | null;
  findings: readonly FindingInput[];
}

interface FindingRow {
  id: number;
  ticket_id: number;
  attempt: number;
  run_at: string;
  process_run_id: number | null;
  severity: string;
  repo: string;
  file: string | null;
  line: number | null;
  title: string;
  detail: string;
  source: string;
  created_at: string;
}

const SEVERITIES: readonly Severity[] = ['critical', 'high', 'medium', 'low', 'info'];
const SOURCES: readonly FindingSource[] = ['agent', 'human'];

/**
 * An unrecognized severity degrades to `'info'` rather than throwing.
 *
 * This module is `review_findings`' only writer, and every write path into it
 * is typed against the closed `Severity` union, so a row this cannot parse can
 * only arrive from direct tampering or a future karst's wider vocabulary — the
 * same reasoning `gate_runs`' `parseArgs` and `merge_checks`' `parseState`
 * apply to their own columns. `'info'` is the vocabulary's inert reading: a
 * severity this reader cannot classify must not silently read as something a
 * consumer would act on (e.g. block a ticket via `blockingSeverity`) that the
 * row's actual value may never have warranted. Data written by this module is
 * always well-formed; this guards the boundary, not the writer.
 */
function parseSeverity(raw: string): Severity {
  return SEVERITIES.includes(raw as Severity) ? (raw as Severity) : 'info';
}

/**
 * An unrecognized source degrades to `'agent'` — the only source any code
 * writes today — for the same reason `parseSeverity` degrades rather than
 * throws: one corrupted row must not take a list query down.
 */
function parseSource(raw: string): FindingSource {
  return SOURCES.includes(raw as FindingSource) ? (raw as FindingSource) : 'agent';
}

function rowToFinding(r: FindingRow): Finding {
  return {
    id: r.id,
    ticketId: r.ticket_id,
    attempt: r.attempt,
    runAt: r.run_at,
    processRunId: r.process_run_id,
    severity: parseSeverity(r.severity),
    repo: r.repo,
    file: r.file,
    line: r.line,
    title: r.title,
    detail: r.detail,
    source: parseSource(r.source),
    createdAt: r.created_at,
  };
}

/**
 * Append one review invocation's findings. Taken as a batch, not finding by
 * finding, so every row shares `runAt` and the batch can be recovered later
 * without depending on `attempt` (which does not increment on a pass) — same
 * shape as `recordGateRun`.
 *
 * Unlike `recordGateRun` (deliberately transactionless, because it is always
 * called from inside `transition`'s premutate so gates and the verdict commit
 * together), this opens its OWN transaction: the findings lane has no
 * accompanying verdict mutation to ride along with, and the multi-row insert
 * below must land all-or-nothing on its own. better-sqlite3 nests this as a
 * SAVEPOINT if a future caller wraps it in an outer transaction, so composing
 * it inside one later remains safe.
 *
 * `created_at` is stamped with the batch's own `runAt`: every row of one
 * invocation is written in this single call, at the same moment, so there is
 * no second timestamp to state independently of the batch stamp the schema
 * already carries for grouping.
 */
export function recordFindings(store: Store, batch: FindingBatch): void {
  if (batch.findings.length === 0) return;
  const insert = store.db.prepare(
    `INSERT INTO review_findings
       (ticket_id, attempt, run_at, severity, repo, file, line, title, detail, source, created_at, process_run_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertBatch = store.db.transaction((items: readonly FindingInput[]) => {
    for (const f of items) {
      insert.run(
        batch.ticketId,
        batch.attempt,
        batch.runAt,
        f.severity,
        f.repo,
        f.file ?? null,
        f.line ?? null,
        f.title,
        f.detail,
        f.source,
        batch.runAt,
        batch.processRunId ?? null,
      );
    }
  });
  insertBatch(batch.findings);
}

/**
 * Every finding ever recorded for a ticket, oldest first (insertion order is
 * report order). Returns everything and groups nothing: picking "the latest
 * batch" is a pure decision (`latestFindingBatch`), testable without a
 * database.
 */
export function listFindings(store: Store, ticketId: number): Finding[] {
  return store.db
    .prepare(
      `SELECT id, ticket_id, attempt, run_at, process_run_id, severity, repo, file, line, title, detail, source, created_at
         FROM review_findings
        WHERE ticket_id = ?
        ORDER BY id`,
    )
    .all(ticketId)
    .map((r) => rowToFinding(r as FindingRow));
}

/**
 * The most recent review invocation's findings for a ticket.
 *
 * Chosen by the greatest `runAt` (ISO stamps sort lexicographically), NOT by
 * array position or `attempt` — `attempt` only increments on a failed
 * verdict, so a fail-then-pass pair can share one attempt. Same reduction
 * `inside/gates.ts`'s `latestBatch` documents for `gate_runs`, kept local here
 * rather than shared because the store layer must not depend on `model/`.
 */
export function latestFindingBatch(store: Store, ticketId: number): Finding[] {
  const all = listFindings(store, ticketId);
  const latest = all.reduce<string | null>(
    (max, f) => (max === null || f.runAt > max ? f.runAt : max),
    null,
  );
  return latest === null ? [] : all.filter((f) => f.runAt === latest);
}

/**
 * One finding by its row id, whatever ticket it belongs to — the typed-action
 * dispatch reloads the row by host-owned id and verifies the ticket itself
 * (`insideActions.ts`), so it must not be scoped to a caller-supplied ticket.
 */
export function getFindingById(store: Store, id: number): Finding | undefined {
  const row = store.db
    .prepare(
      `SELECT id, ticket_id, attempt, run_at, process_run_id, severity, repo, file, line, title, detail, source, created_at
         FROM review_findings
        WHERE id = ?`,
    )
    .get(id) as FindingRow | undefined;
  return row === undefined ? undefined : rowToFinding(row);
}
