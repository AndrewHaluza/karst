import type { Store } from './db.js';

/**
 * Planning sessions (v65) — a read-only, stack-aware agent conversation that
 * investigates before any ticket exists, then files draft tickets.
 *
 * Deliberately NOT a ticket and NOT a stage: planning has no deterministic
 * verdict, so it stays out of the stage graph. A session only records what it
 * produced (`planning_session_tickets`); linking the first ticket marks it
 * `filed`.
 */

export const PLANNING_SESSIONS_DDL = `
CREATE TABLE IF NOT EXISTS planning_sessions (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id       INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title            TEXT NOT NULL,
  core             TEXT NOT NULL,
  model            TEXT,
  status           TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'filed', 'archived')),
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_planning_sessions_project ON planning_sessions(project_id, status);
CREATE TABLE IF NOT EXISTS planning_session_tickets (
  session_id INTEGER NOT NULL REFERENCES planning_sessions(id) ON DELETE CASCADE,
  ticket_id  INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  linked_at  TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (session_id, ticket_id)
);
CREATE TABLE IF NOT EXISTS planning_proposals (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id   INTEGER NOT NULL REFERENCES planning_sessions(id) ON DELETE CASCADE,
  payload_json TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'discarded')),
  ticket_id    INTEGER REFERENCES tickets(id) ON DELETE SET NULL,
  source_uuid  TEXT NOT NULL DEFAULT '',
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_planning_proposals_session ON planning_proposals(session_id, status);
`;

export type PlanningStatus = 'active' | 'filed' | 'archived';

export interface PlanningSession {
  id: number;
  projectId: number;
  title: string;
  core: string;
  model: string | null;
  status: PlanningStatus;
  createdAt: string;
  updatedAt: string;
}

export interface NewPlanningSession {
  projectId: number;
  title: string;
  core: string;
  model: string | null;
}

interface PlanningSessionRow {
  id: number;
  project_id: number;
  title: string;
  core: string;
  model: string | null;
  status: PlanningStatus;
  created_at: string;
  updated_at: string;
}

const COLUMNS =
  'id, project_id, title, core, model, status, created_at, updated_at';

function toSession(r: PlanningSessionRow): PlanningSession {
  return {
    id: r.id,
    projectId: r.project_id,
    title: r.title,
    core: r.core,
    model: r.model,
    status: r.status,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function getPlanningSession(store: Store, id: number): PlanningSession | undefined {
  const row = store.db
    .prepare(`SELECT ${COLUMNS} FROM planning_sessions WHERE id = ?`)
    .get(id) as PlanningSessionRow | undefined;
  return row ? toSession(row) : undefined;
}

function requireSession(store: Store, id: number): PlanningSession {
  const s = getPlanningSession(store, id);
  if (!s) throw new Error(`planning session ${id} not found`);
  return s;
}

/** Longest stored title; it becomes a terminal tab name and a sidebar row. */
export const PLANNING_TITLE_MAX = 120;

/**
 * The ONE title normalizer: control characters (incl. ESC, so no terminal
 * escape reaches a tab name) and whitespace runs collapse to one space, then
 * the result is trimmed and capped.
 */
function sanitizeTitle(raw: string): string {
  // eslint-disable-next-line no-control-regex
  return raw.replace(/[\s\u0000-\u001f\u007f-\u009f]+/g, ' ').trim().slice(0, PLANNING_TITLE_MAX).trim();
}

export function createPlanningSession(store: Store, input: NewPlanningSession): PlanningSession {
  const title = sanitizeTitle(input.title);
  if (!title) throw new Error('planning session title must not be blank');
  const { lastInsertRowid } = store.db
    .prepare('INSERT INTO planning_sessions (project_id, title, core, model) VALUES (?, ?, ?, ?)')
    .run(input.projectId, title, input.core, input.model);
  return requireSession(store, Number(lastInsertRowid));
}

export function listPlanningSessions(
  store: Store,
  projectId: number,
  opts: { includeArchived?: boolean } = {},
): PlanningSession[] {
  const filter = opts.includeArchived ? '' : "AND status <> 'archived'";
  const rows = store.db
    .prepare(`SELECT ${COLUMNS} FROM planning_sessions WHERE project_id = ? ${filter} ORDER BY id DESC`)
    .all(projectId) as PlanningSessionRow[];
  return rows.map(toSession);
}

export function setPlanningSessionStatus(store: Store, id: number, status: PlanningStatus): PlanningSession {
  requireSession(store, id);
  store.db
    .prepare("UPDATE planning_sessions SET status = ?, updated_at = datetime('now') WHERE id = ?")
    .run(status, id);
  return requireSession(store, id);
}

/** Remove a session outright — only for a create whose first launch failed. */
export function deletePlanningSession(store: Store, id: number): void {
  store.db.prepare('DELETE FROM planning_sessions WHERE id = ?').run(id);
}

/**
 * Idempotent. Linking the first ticket moves an active session to `filed`.
 * No transaction: the CLI's node:sqlite shim does not nest, and both writes
 * are idempotent, so a retry after a crash between them converges.
 */
export function linkPlanningTicket(store: Store, sessionId: number, ticketId: number): void {
  const session = requireSession(store, sessionId);
  store.db
    .prepare('INSERT OR IGNORE INTO planning_session_tickets (session_id, ticket_id) VALUES (?, ?)')
    .run(sessionId, ticketId);
  if (session.status === 'active') setPlanningSessionStatus(store, sessionId, 'filed');
}

export function listPlanningTickets(store: Store, sessionId: number): number[] {
  const rows = store.db
    .prepare('SELECT ticket_id FROM planning_session_tickets WHERE session_id = ? ORDER BY linked_at, ticket_id')
    .all(sessionId) as { ticket_id: number }[];
  return rows.map((r) => r.ticket_id);
}
