import type { Store } from './db.js';

/**
 * The record of an auto-deliver gate run (T1018, @arch:EVIDENCE-WHEN): the ship-stage gates Karst runs on a
 * resolved merge before it pushes. A run row opens BEFORE the first gate; one result row is appended as each gate
 * finishes, with the head SHA of the merged tree. Results are append-only evidence: a takeover, a new push or a new
 * run never deletes one. Only `dismissed_at` is set, by the user. The tables are separate from `gate_runs` on purpose:
 * `gate_runs` is keyed to the stage machine, and a ship-stage row there would feed the verdict readers.
 */
export const DELIVER_RUNS_DDL = `
CREATE TABLE IF NOT EXISTS deliver_runs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id   INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  head_sha    TEXT,
  gates       TEXT NOT NULL,
  current_gate TEXT,
  state       TEXT NOT NULL CHECK (state IN ('running', 'passed', 'failed', 'taken-over', 'stopped')),
  pid         INTEGER,
  started_at  TEXT NOT NULL,
  ended_at    TEXT,
  kind        TEXT NOT NULL DEFAULT 'auto'
);
CREATE INDEX IF NOT EXISTS idx_deliver_runs_ticket ON deliver_runs(ticket_id, id);
CREATE TABLE IF NOT EXISTS deliver_gate_results (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id       INTEGER NOT NULL REFERENCES deliver_runs(id) ON DELETE CASCADE,
  ticket_id    INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  gate_name    TEXT NOT NULL,
  repo         TEXT NOT NULL,
  exit_code    INTEGER,
  head_sha     TEXT,
  summary      TEXT,
  started_at   TEXT,
  ended_at     TEXT,
  dismissed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_deliver_results_ticket ON deliver_gate_results(ticket_id, id);
`;

export type DeliverRunState = 'running' | 'passed' | 'failed' | 'taken-over' | 'stopped';

/**
 * What started a run: `auto` = the auto-deliver of a resolved merge, `after-take-over` = the re-run of the gates a
 * manual Deliver skipped, on the pushed head (D540),
 * `base-moved` = the gates of the branch merged with the moved base, before a push (D541). A re-run stopped by a newer push ends `stopped`, never `failed`.
 */
export type DeliverRunKind = 'auto' | 'after-take-over' | 'base-moved';
const KINDS: readonly string[] = ['auto', 'after-take-over', 'base-moved'];

export interface DeliverRun {
  readonly id: number;
  readonly ticketId: number;
  readonly headSha: string | null;
  /** The planned gate names, in run order. */
  readonly gates: readonly string[];
  /** The gate that runs now, or null between gates. */
  readonly currentGate: string | null;
  /** Gates that finished (one result each). */
  readonly finished: number;
  readonly state: DeliverRunState;
  readonly kind: DeliverRunKind;
  readonly startedAt: string;
  readonly endedAt: string | null;
}

export interface DeliverGateResult {
  readonly id: number;
  readonly runId: number;
  readonly gateName: string;
  readonly repo: string;
  readonly exitCode: number | null;
  readonly headSha: string | null;
  readonly summary: string | null;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
  readonly dismissedAt: string | null;
}

export interface DeliverGateInput {
  readonly gateName: string;
  readonly repo: string;
  readonly exitCode: number | null;
  readonly summary: string | null;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
  /** The head of this gate's own worktree; absent → the run's head. */
  readonly headSha?: string | null;
}

interface RunRow {
  id: number; ticket_id: number; head_sha: string | null; gates: string; current_gate: string | null;
  state: string; started_at: string; ended_at: string | null; finished: number; kind: string;
}
interface ResultRow {
  id: number; run_id: number; gate_name: string; repo: string; exit_code: number | null; head_sha: string | null;
  summary: string | null; started_at: string | null; ended_at: string | null; dismissed_at: string | null;
}

const STATES: readonly string[] = ['running', 'passed', 'failed', 'taken-over', 'stopped'];

function parseGates(raw: string): string[] {
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) && v.every((g): g is string => typeof g === 'string') ? v : [];
  } catch {
    return [];
  }
}

const rowToRun = (r: RunRow): DeliverRun => ({
  id: r.id,
  ticketId: r.ticket_id,
  headSha: r.head_sha,
  gates: parseGates(r.gates),
  currentGate: r.current_gate,
  finished: r.finished,
  state: (STATES.includes(r.state) ? r.state : 'stopped') as DeliverRunState,
  kind: (KINDS.includes(r.kind) ? r.kind : 'auto') as DeliverRunKind,
  startedAt: r.started_at,
  endedAt: r.ended_at,
});

const rowToResult = (r: ResultRow): DeliverGateResult => ({
  id: r.id, runId: r.run_id, gateName: r.gate_name, repo: r.repo, exitCode: r.exit_code, headSha: r.head_sha,
  summary: r.summary, startedAt: r.started_at, endedAt: r.ended_at, dismissedAt: r.dismissed_at,
});

const RUN_SELECT = `SELECT r.id, r.ticket_id, r.head_sha, r.gates, r.current_gate, r.state, r.kind, r.started_at, r.ended_at,
  (SELECT COUNT(*) FROM deliver_gate_results g WHERE g.run_id = r.id) AS finished FROM deliver_runs r`;

export interface OpenDeliverRunInput {
  readonly ticketId: number;
  readonly headSha: string | null;
  readonly gates: readonly string[];
  readonly pid: number | null;
  readonly now: string;
  /** Default `auto`. */
  readonly kind?: DeliverRunKind;
}

/** Open a run before its first gate. A run still `running` for the ticket is closed as `stopped` first. */
export function openDeliverRun(store: Store, input: OpenDeliverRunInput): number {
  store.db.prepare("UPDATE deliver_runs SET state = 'stopped', ended_at = ? WHERE ticket_id = ? AND state = 'running'").run(input.now, input.ticketId);
  const info = store.db
    .prepare("INSERT INTO deliver_runs (ticket_id, head_sha, gates, state, pid, started_at, kind) VALUES (?, ?, ?, 'running', ?, ?, ?)")
    .run(input.ticketId, input.headSha, JSON.stringify(input.gates), input.pid, input.now, input.kind ?? 'auto');
  return Number(info.lastInsertRowid);
}

export function setDeliverProgress(store: Store, runId: number, currentGate: string | null): void {
  store.db.prepare('UPDATE deliver_runs SET current_gate = ? WHERE id = ?').run(currentGate, runId);
}

/** Append one gate result NOW; it carries the run's head SHA. */
export function recordDeliverGate(store: Store, runId: number, g: DeliverGateInput): void {
  store.db
    .prepare(
      `INSERT INTO deliver_gate_results (run_id, ticket_id, gate_name, repo, exit_code, head_sha, summary, started_at, ended_at)
       SELECT id, ticket_id, ?, ?, ?, COALESCE(?, head_sha), ?, ?, ? FROM deliver_runs WHERE id = ?`,
    )
    .run(g.gateName, g.repo, g.exitCode, g.headSha ?? null, g.summary, g.startedAt, g.endedAt, runId);
}

/** Close a run. A run that is no longer `running` (a takeover closed it) keeps its state. */
export function finishDeliverRun(store: Store, runId: number, state: Exclude<DeliverRunState, 'running' | 'taken-over'>, now: string): void {
  store.db.prepare("UPDATE deliver_runs SET state = ?, current_gate = NULL, ended_at = ? WHERE id = ? AND state = 'running'").run(state, now, runId);
}

export function currentDeliverRun(store: Store, ticketId: number): DeliverRun | null {
  const row = store.db.prepare(`${RUN_SELECT} WHERE r.ticket_id = ? ORDER BY r.id DESC LIMIT 1`).get(ticketId) as RunRow | undefined;
  return row ? rowToRun(row) : null;
}

/** One run by id, so a caller reads the run it opened, not the newest run of the ticket. */
export function getDeliverRun(store: Store, runId: number): DeliverRun | null {
  const row = store.db.prepare(`${RUN_SELECT} WHERE r.id = ?`).get(runId) as RunRow | undefined;
  return row ? rowToRun(row) : null;
}

export function listDeliverResults(store: Store, ticketId: number): DeliverGateResult[] {
  return store.db
    .prepare('SELECT * FROM deliver_gate_results WHERE ticket_id = ? ORDER BY id')
    .all(ticketId)
    .map((r) => rowToResult(r as ResultRow));
}

export interface TakeOver {
  readonly failed: readonly string[];
  readonly skipped: readonly string[];
}

/** The planned gates that have no result yet. A name that repeats (one gate per repo) is missing once per absent result. */
export function skippedGates(planned: readonly string[], resultNames: readonly string[]): string[] {
  const left = new Map<string, number>();
  for (const n of resultNames) left.set(n, (left.get(n) ?? 0) + 1);
  return planned.filter((g) => {
    const n = left.get(g) ?? 0;
    if (n === 0) return true;
    left.set(g, n - 1);
    return false;
  });
}

/** Mark the running run `taken-over`; null when none runs. Failed = non-zero results, skipped = planned gates with no result. */
export function takeOverDeliverRun(store: Store, ticketId: number, now: string): TakeOver | null {
  const run = currentDeliverRun(store, ticketId);
  if (run === null || run.state !== 'running') return null;
  const results = listDeliverResults(store, ticketId).filter((r) => r.runId === run.id);
  store.db.prepare("UPDATE deliver_runs SET state = 'taken-over', current_gate = NULL, ended_at = ? WHERE id = ?").run(now, run.id);
  return {
    failed: results.filter((r) => r.exitCode !== null && r.exitCode !== 0).map((r) => r.gateName),
    skipped: skippedGates(run.gates, results.map((r) => r.gateName)),
  };
}

/**
 * Failures still on record: not dismissed, and not followed by a pass of the same gate (same repo) on a NEWER head.
 * A manual Deliver, a push or a new run never removes one.
 */
export function listDeliverFailures(store: Store, ticketId: number): DeliverGateResult[] {
  const all = listDeliverResults(store, ticketId);
  return all.filter(
    (f) =>
      f.exitCode !== null && f.exitCode !== 0 && f.dismissedAt === null &&
      !all.some((p) => p.id > f.id && p.exitCode === 0 && p.gateName === f.gateName && p.repo === f.repo && p.headSha !== f.headSha),
  );
}

/** The user dismisses the failure record of one gate, or of every gate when `gateName` is null. */
export function dismissDeliverFailures(store: Store, ticketId: number, gateName: string | null, now: string): void {
  store.db
    .prepare(
      `UPDATE deliver_gate_results SET dismissed_at = ?
        WHERE ticket_id = ? AND dismissed_at IS NULL AND exit_code IS NOT NULL AND exit_code != 0
          AND (? IS NULL OR gate_name = ?)`,
    )
    .run(now, ticketId, gateName, gateName);
}

/** At activation: a `running` run whose host process is gone never finished. Returns how many were closed. */
export function stopStaleDeliverRuns(store: Store, isAlive: (pid: number) => boolean, now: string): number {
  const rows = store.db.prepare("SELECT id, pid FROM deliver_runs WHERE state = 'running'").all() as Array<{ id: number; pid: number | null }>;
  let n = 0;
  for (const r of rows) {
    if (r.pid !== null && isAlive(r.pid)) continue;
    store.db.prepare("UPDATE deliver_runs SET state = 'stopped', current_gate = NULL, ended_at = ? WHERE id = ?").run(now, r.id);
    n += 1;
  }
  return n;
}
