import { join } from 'node:path';
import type { Store } from '../../store/db.js';
import type { LogLevel } from '../../logging/logger.js';
import { nowIso } from '../../model/time.js';

/**
 * The agent test driver's store seam (Phase 1 of the agent-test-driver ticket).
 *
 * The `karst test` CLI verb records two kinds of structured evidence that
 * production code never writes: `test_logs` (a mirror of what the extension
 * would have logged to its output channel, as rows a test can filter) and
 * `test_hooks` (hook events `simulate-hook` dispatched, with the agent_state
 * the dispatch left behind). Everything here is a WRITE or READ over those two
 * v35 tables plus one worktree-ensure helper — deliberately small, and the
 * ONLY module that touches them, so the tables cannot drift into use by
 * production paths.
 *
 * The driver records on every invocation of the `test` verb — there is no
 * separate opt-in — because the verb itself IS the test mode: its only purpose
 * is to drive and inspect a workflow, and the example scripts the ticket ships
 * (get-hooks right after simulate-hook, no extra flag) depend on recording
 * being on. Normal verbs (`context`/`stage`/`phase`) never open this seam, so a
 * production registry accumulates nothing here.
 */

export interface TestLogRow {
  id: number;
  ticketId: number | null;
  level: LogLevel;
  module: string;
  message: string;
  /** Parsed JSON meta; null when absent or unparseable. */
  meta: unknown;
  recordedAt: string;
}

export interface TestHookRow {
  id: number;
  ticketId: number | null;
  event: string;
  sessionId: string | null;
  /** Parsed JSON payload; null when absent or unparseable. */
  payload: unknown;
  agentStateAfter: string | null;
  recordedAt: string;
}

interface TestLogRowRaw {
  id: number;
  ticket_id: number | null;
  level: string;
  module: string;
  message: string;
  meta: string | null;
  recorded_at: string;
}

interface TestHookRowRaw {
  id: number;
  ticket_id: number | null;
  event: string;
  session_id: string | null;
  payload: string | null;
  agent_state_after: string | null;
  recorded_at: string;
}

function parseJson(raw: string | null): unknown {
  if (raw === null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export interface TestLogInput {
  /** Omit for a not-ticket-scoped entry (e.g. a reset or driver-level event). */
  ticketId?: number;
  level: LogLevel;
  module: string;
  message: string;
  /** Structured payload, stored as JSON; read back through `get-logs`. */
  meta?: unknown;
}

/** Append one structured log row; the driver's mirror of a logger call. */
export function recordTestLog(store: Store, input: TestLogInput): number {
  const info = store.db
    .prepare(
      `INSERT INTO test_logs (ticket_id, level, module, message, meta, recorded_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.ticketId ?? null,
      input.level,
      input.module,
      input.message,
      input.meta === undefined ? null : JSON.stringify(input.meta),
      nowIso(),
    );
  return Number(info.lastInsertRowid);
}

export interface TestLogFilter {
  ticketId?: number;
  level?: LogLevel;
  /** Substring match on `message` (plain `instr`, no LIKE wildcards). */
  pattern?: string;
  /** Only entries recorded at or after this instant (ISO-8601). */
  since?: string;
}

function rowToTestLog(r: TestLogRowRaw): TestLogRow {
  return {
    id: r.id,
    ticketId: r.ticket_id,
    level: r.level as LogLevel,
    module: r.module,
    message: r.message,
    meta: parseJson(r.meta),
    recordedAt: r.recorded_at,
  };
}

/**
 * Read back recorded test logs, oldest first. Every filter is optional and
 * combined conjunctively; a present-but-empty `pattern` matches nothing (a test
 * asserting "no matching log" can pass a literal no-op like `zzz` — or omit the
 * pattern, which matches everything).
 */
export function listTestLogs(store: Store, filter: TestLogFilter = {}): TestLogRow[] {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (filter.ticketId !== undefined) {
    where.push('ticket_id = ?');
    params.push(filter.ticketId);
  }
  if (filter.level !== undefined) {
    where.push('level = ?');
    params.push(filter.level);
  }
  if (filter.pattern !== undefined) {
    where.push('instr(message, ?) > 0');
    params.push(filter.pattern);
  }
  if (filter.since !== undefined) {
    where.push('recorded_at >= ?');
    params.push(filter.since);
  }
  const sql = `SELECT id, ticket_id, level, module, message, meta, recorded_at
                 FROM test_logs
                 ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
                 ORDER BY id`;
  return (store.db.prepare(sql).all(...params) as TestLogRowRaw[]).map(rowToTestLog);
}

export interface TestHookInput {
  ticketId: number;
  event: string;
  sessionId?: string | null;
  payload?: unknown;
  agentStateAfter: string | null;
}

/** Append one dispatched hook event, with the agent_state the dispatch left. */
export function recordTestHook(store: Store, input: TestHookInput): number {
  const info = store.db
    .prepare(
      `INSERT INTO test_hooks (ticket_id, event, session_id, payload, agent_state_after, recorded_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.ticketId,
      input.event,
      input.sessionId ?? null,
      input.payload === undefined ? null : JSON.stringify(input.payload),
      input.agentStateAfter,
      nowIso(),
    );
  return Number(info.lastInsertRowid);
}

function rowToTestHook(r: TestHookRowRaw): TestHookRow {
  return {
    id: r.id,
    ticketId: r.ticket_id,
    event: r.event,
    sessionId: r.session_id,
    payload: parseJson(r.payload),
    agentStateAfter: r.agent_state_after,
    recordedAt: r.recorded_at,
  };
}

/** Every hook event the driver dispatched for a ticket, in dispatch order. */
export function listTestHooks(store: Store, ticketId: number): TestHookRow[] {
  return (
    store.db
      .prepare(
        `SELECT id, ticket_id, event, session_id, payload, agent_state_after, recorded_at
           FROM test_hooks
          WHERE ticket_id = ?
          ORDER BY id`,
      )
      .all(ticketId) as TestHookRowRaw[]
  ).map(rowToTestHook);
}

/**
 * The synthetic worktree path a ticket's simulate-hook dispatches default to
 * when the caller gives no `--cwd`. Deterministic per ticket so repeated
 * dispatches (and the `cwd → ticket` resolution in `dispatchHook`) always agree.
 * It is deliberately a filesystem-shaped path rather than a URI: the hook
 * boundary resolves `cwd` through `canonicalPath`, which walks up to the deepest
 * existing ancestor and rejoins the tail — works for any path, but a plain path
 * keeps the record honest on inspection.
 */
export function testWorktreePath(ticketId: number, key: string): string {
  return join('/karst', 'test', `${ticketId}-${key}`);
}

/**
 * Make the hook boundary's `cwd → ticket` resolution admit a ticket whose
 * simulate-hook dispatch has no real worktree behind it. `dispatchHook` resolves
 * the payload's `cwd` against the `worktrees` table and silently drops an
 * unknown path, so a driver that wants to dispatch on a freshly-created ticket
 * must first record a worktree row for it — the same state a real scope stage
 * would have produced.
 *
 * The worktrees table has no uniqueness, so this is a check-then-insert (never a
 * blind second row). A path that already maps to a DIFFERENT ticket is left
 * alone — the caller's dispatch would then be ignored, which is honest.
 */
export function ensureTestWorktree(store: Store, ticketId: number, path: string): void {
  const existing = store.db
    .prepare('SELECT ticket_id FROM worktrees WHERE path = ?')
    .get(path) as { ticket_id: number } | undefined;
  if (existing !== undefined) return;
  store.db
    .prepare(
      `INSERT INTO worktrees (ticket_id, repo, path, branch, base_ref)
       VALUES (?, 'app', ?, ?, 'test')`,
    )
    .run(ticketId, path, `karst/test/${ticketId}`);
}
