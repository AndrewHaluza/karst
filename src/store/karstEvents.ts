import type { Store } from './db.js';

/**
 * The Karst events table (v128, @arch:EVENTS): what Karst did and told the person.
 * Person-facing outcomes only (toast text, action results, Autopilot status, merges,
 * send-backs), never debug lines. Project-scoped, store-only (better-sqlite3 and the
 * CLI node:sqlite shim), one synchronous insert per call (@arch:EVENTLOOP).
 */

/** The DDL schema.sql mirrors for a fresh DB (the v128 migration step execs it). */
export const KARST_EVENTS_DDL = `
CREATE TABLE IF NOT EXISTS karst_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
  ticket_id  INTEGER REFERENCES tickets(id) ON DELETE CASCADE,
  level      TEXT NOT NULL CHECK (level IN ('info', 'success', 'warn', 'error')),
  source     TEXT NOT NULL CHECK (source IN ('host', 'panel', 'autopilot', 'merge', 'ship')),
  title      TEXT NOT NULL,
  body       TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  read_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_karst_events_project ON karst_events(project_id, id);
CREATE INDEX IF NOT EXISTS idx_karst_events_unread ON karst_events(project_id, read_at);
`;

/** Title cap (one short line). */
export const EVENT_TITLE_MAX = 120;
/** Body cap, matching the bulletin body cap. */
export const EVENT_BODY_MAX = 4096;
/** A project's events older than this many days go on the next record. */
export const EVENT_MAX_AGE_DAYS = 30;
/** A project keeps at most this many events; the oldest go first. */
export const EVENT_MAX_ROWS_PER_PROJECT = 5000;

export type EventLevel = 'info' | 'success' | 'warn' | 'error';
export type EventSource = 'host' | 'panel' | 'autopilot' | 'merge' | 'ship';

export interface KarstEvent {
  id: number;
  projectId: number;
  ticketId: number | null;
  level: EventLevel;
  source: EventSource;
  title: string;
  body: string;
  createdAt: string;
  readAt: string | null;
}

export interface RecordEventInput {
  projectId: number;
  ticketId?: number;
  level: EventLevel;
  source: EventSource;
  title: string;
  body?: string;
}

export interface ListEventsInput {
  projectId: number;
  limit: number;
  /** Return only rows with an id below this one (the page cursor). */
  beforeId?: number;
}

interface EventRow {
  id: number;
  project_id: number;
  ticket_id: number | null;
  level: EventLevel;
  source: EventSource;
  title: string;
  body: string;
  created_at: string;
  read_at: string | null;
}

/** Cut `text` to `max` characters, ending with an ellipsis when it was longer. */
function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** The level of an Autopilot status title: a stop or a pause is an error, a refusal or a failure a warning, the rest info. */
export function autopilotEventLevel(title: string): EventLevel {
  if (/^Autopilot: (auto-fix stopped|paused)/u.test(title)) return 'error';
  if (/not run|failed/u.test(title)) return 'warn';
  return 'info';
}

/** A control character (tab and newline kept) becomes a blank, so a pasted escape cannot repaint a terminal. */
function clean(text: string): string {
  return text.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029]/gu, ' ');
}

function oneLine(text: string): string {
  return clean(text).replace(/\s+/gu, ' ').trim();
}

/** Listeners per store; a record in this window tells the sidebar, which the data_version watch (other connections) never does. */
const recordListeners = new WeakMap<Store, Set<() => void>>();

/** Call `listener` after every event this store records. Returns the unsubscribe function. */
export function onEventRecorded(store: Store, listener: () => void): () => void {
  const set = recordListeners.get(store) ?? new Set<() => void>();
  set.add(listener);
  recordListeners.set(store, set);
  return () => { set.delete(listener); };
}

function notifyRecorded(store: Store, debug: (m: string) => void): void {
  for (const listener of recordListeners.get(store) ?? []) {
    try {
      listener();
    } catch (err) {
      debug(`[store] karst event listener failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

/**
 * Record one event and trim the project's history in the same transaction. Never throws:
 * a failure is logged through `debug` and the result is null, so a status line can never
 * break the flow that wrote it.
 */
export function recordEvent(store: Store, input: RecordEventInput, debug: (m: string) => void): number | null {
  const title = clip(oneLine(input.title), EVENT_TITLE_MAX);
  const body = clip(clean(input.body ?? '').trim(), EVENT_BODY_MAX);
  try {
    const run = store.db.transaction((): number => {
      const info = store.db
        .prepare('INSERT INTO karst_events (project_id, ticket_id, level, source, title, body) VALUES (?, ?, ?, ?, ?, ?)')
        .run(input.projectId, input.ticketId ?? null, input.level, input.source, title === '' ? input.source : title, body);
      store.db
        .prepare(`DELETE FROM karst_events WHERE project_id = ? AND created_at < datetime('now', ?)`)
        .run(input.projectId, `-${EVENT_MAX_AGE_DAYS} days`);
      store.db
        .prepare(
          `DELETE FROM karst_events WHERE project_id = ? AND id <= (
             SELECT id FROM karst_events WHERE project_id = ? ORDER BY id DESC LIMIT 1 OFFSET ?)`,
        )
        .run(input.projectId, input.projectId, EVENT_MAX_ROWS_PER_PROJECT);
      return Number(info.lastInsertRowid);
    });
    const id = run();
    notifyRecorded(store, debug);
    return id;
  } catch (err) {
    debug(`[store] karst event failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

function rowToEvent(r: EventRow): KarstEvent {
  return {
    id: r.id, projectId: r.project_id, ticketId: r.ticket_id, level: r.level, source: r.source,
    title: r.title, body: r.body, createdAt: r.created_at, readAt: r.read_at,
  };
}

/** The project's events, newest first. */
export function listEvents(store: Store, input: ListEventsInput): KarstEvent[] {
  const rows = store.db
    .prepare('SELECT * FROM karst_events WHERE project_id = ? AND id < ? ORDER BY id DESC LIMIT ?')
    .all(input.projectId, input.beforeId ?? Number.MAX_SAFE_INTEGER, input.limit) as EventRow[];
  return rows.map(rowToEvent);
}

export function unreadEventCount(store: Store, projectId: number): number {
  const row = store.db
    .prepare('SELECT COUNT(*) AS n FROM karst_events WHERE project_id = ? AND read_at IS NULL')
    .get(projectId) as { n: number };
  return row.n;
}

/** Mark one event read. A row already read keeps its first read time. */
export function markEventRead(store: Store, id: number): void {
  store.db.prepare("UPDATE karst_events SET read_at = datetime('now') WHERE id = ? AND read_at IS NULL").run(id);
}

export function markAllEventsRead(store: Store, projectId: number): void {
  store.db.prepare("UPDATE karst_events SET read_at = datetime('now') WHERE project_id = ? AND read_at IS NULL").run(projectId);
}

/** One event by id, or null when it does not exist. */
export function getEvent(store: Store, id: number): KarstEvent | null {
  const row = store.db.prepare('SELECT * FROM karst_events WHERE id = ?').get(id) as EventRow | undefined;
  return row ? rowToEvent(row) : null;
}

/** How many events the project holds (read and unread). */
export function countEvents(store: Store, projectId: number): number {
  const row = store.db.prepare('SELECT COUNT(*) AS n FROM karst_events WHERE project_id = ?').get(projectId) as { n: number };
  return row.n;
}
