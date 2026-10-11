import type { Store } from './db.js';

/**
 * Fix-brief delivery snapshots (v77, @arch:V77). A fix round that reaches a LIVE
 * interactive session stores its brief here and sends only a fixed pointer line
 * through the mailbox's per-core route; the agent's `karst fix-brief --ack` read
 * is the receipt (`read_at`). Not the `ticket_messages` mailbox: that table's
 * 4096-char cap, parent/child addressing and parent-wake logic must never see a
 * fix row.
 *
 * Every state transition is a conditional UPDATE claim (`… WHERE col IS NULL`,
 * like `claimWake`), so two windows or a reload never double-act. This module is
 * the ONLY writer. Timestamps are caller-supplied ISO strings (injectable clock).
 */

/** The DDL schema.sql mirrors for a fresh DB (the v77 migration step execs it). */
export const FIX_DELIVERIES_DDL = `
CREATE TABLE IF NOT EXISTS fix_deliveries (
  id                INTEGER PRIMARY KEY AUTOINCREMENT, -- the user-facing "fix brief #<id>"
  project_id        INTEGER REFERENCES projects(id) ON DELETE CASCADE,
  ticket_id         INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  recovery_round_id INTEGER REFERENCES recovery_rounds(id) ON DELETE SET NULL,
  launch_id         TEXT,    -- the session generation this delivery is armed for
  body              TEXT NOT NULL,
  truncated         INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT NOT NULL,
  armed_at          TEXT,    -- push route: the hook may point at it
  enqueued_at       TEXT,    -- typed route: a pointer line is in flight
  pointed_at        TEXT,    -- the pointer reached the agent
  repointed_at      TEXT,    -- the typed re-send went out
  pointer_failed_at TEXT,    -- the pointer could not be built (needs-you, once)
  read_at           TEXT,    -- the receipt
  delivered_via     TEXT CHECK (delivered_via IN ('seed', 'pointer')),
  superseded_at     TEXT
);
CREATE INDEX IF NOT EXISTS idx_fix_deliveries_ticket
  ON fix_deliveries(ticket_id, superseded_at, read_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_fix_deliveries_round
  ON fix_deliveries(ticket_id, recovery_round_id) WHERE recovery_round_id IS NOT NULL;
`;

/** Cap on a stored brief (chars). Over the cap the tail is replaced by a footer. */
export const MAX_FIX_BODY = 64 * 1024;

export type FixDeliveredVia = 'seed' | 'pointer';

export interface FixDelivery {
  id: number;
  projectId: number | null;
  ticketId: number;
  recoveryRoundId: number | null;
  launchId: string | null;
  body: string;
  truncated: boolean;
  createdAt: string;
  armedAt: string | null;
  enqueuedAt: string | null;
  pointedAt: string | null;
  repointedAt: string | null;
  pointerFailedAt: string | null;
  readAt: string | null;
  deliveredVia: FixDeliveredVia | null;
  supersededAt: string | null;
}

interface FixDeliveryRow {
  id: number;
  project_id: number | null;
  ticket_id: number;
  recovery_round_id: number | null;
  launch_id: string | null;
  body: string;
  truncated: number;
  created_at: string;
  armed_at: string | null;
  enqueued_at: string | null;
  pointed_at: string | null;
  repointed_at: string | null;
  pointer_failed_at: string | null;
  read_at: string | null;
  delivered_via: FixDeliveredVia | null;
  superseded_at: string | null;
}

function rowToDelivery(r: FixDeliveryRow): FixDelivery {
  return {
    id: r.id,
    projectId: r.project_id,
    ticketId: r.ticket_id,
    recoveryRoundId: r.recovery_round_id,
    launchId: r.launch_id,
    body: r.body,
    truncated: r.truncated !== 0,
    createdAt: r.created_at,
    armedAt: r.armed_at,
    enqueuedAt: r.enqueued_at,
    pointedAt: r.pointed_at,
    repointedAt: r.repointed_at,
    pointerFailedAt: r.pointer_failed_at,
    readAt: r.read_at,
    deliveredVia: r.delivered_via,
    supersededAt: r.superseded_at,
  };
}

/** Cap a brief at `MAX_FIX_BODY`; over the cap the tail becomes `footer`. */
export function capFixBody(body: string, footer: string): { body: string; truncated: boolean } {
  if (body.length <= MAX_FIX_BODY) return { body, truncated: false };
  const keep = Math.max(0, MAX_FIX_BODY - footer.length - 1);
  return { body: `${body.slice(0, keep)}\n${footer}`, truncated: true };
}

export interface UpsertFixDeliveryInput {
  ticketId: number;
  recoveryRoundId: number | null;
  launchId: string | null;
  body: string;
  /** Appended (with the cut) when the body exceeds `MAX_FIX_BODY`. */
  truncatedFooter?: string;
  at: string;
}

/**
 * Write the snapshot for a fix delivery and return the row id. One transaction
 * (a savepoint when nested in the seed path's outer one):
 *  - a tracked round that already has a row is UPDATED in place — a new attempt
 *    is a new delivery, so every claim and the receipt reset;
 *  - otherwise a row is INSERTED;
 *  - then every OTHER unread row of the ticket is superseded.
 */
export function upsertFixDelivery(store: Store, input: UpsertFixDeliveryInput): number {
  const { body, truncated } = capFixBody(input.body, input.truncatedFooter ?? '');
  const write = store.db.transaction((): number => {
    let id: number | null = null;
    if (input.recoveryRoundId !== null) {
      const existing = store.db
        .prepare('SELECT id FROM fix_deliveries WHERE ticket_id = ? AND recovery_round_id = ?')
        .get(input.ticketId, input.recoveryRoundId) as { id: number } | undefined;
      if (existing !== undefined) {
        store.db
          .prepare(
            `UPDATE fix_deliveries
                SET body = ?, truncated = ?, launch_id = ?, created_at = ?,
                    armed_at = NULL, enqueued_at = NULL, pointed_at = NULL,
                    repointed_at = NULL, pointer_failed_at = NULL, read_at = NULL,
                    delivered_via = NULL, superseded_at = NULL
              WHERE id = ?`,
          )
          .run(body, truncated ? 1 : 0, input.launchId, input.at, existing.id);
        id = existing.id;
      }
    }
    if (id === null) {
      const project = store.db
        .prepare('SELECT project_id FROM tickets WHERE id = ?')
        .get(input.ticketId) as { project_id: number | null } | undefined;
      const info = store.db
        .prepare(
          `INSERT INTO fix_deliveries
             (project_id, ticket_id, recovery_round_id, launch_id, body, truncated, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          project?.project_id ?? null,
          input.ticketId,
          input.recoveryRoundId,
          input.launchId,
          body,
          truncated ? 1 : 0,
          input.at,
        );
      id = Number(info.lastInsertRowid);
    }
    store.db
      .prepare(
        `UPDATE fix_deliveries SET superseded_at = ?
          WHERE ticket_id = ? AND id <> ? AND read_at IS NULL AND superseded_at IS NULL`,
      )
      .run(input.at, input.ticketId, id);
    return id;
  });
  return write();
}

export function getFixDelivery(store: Store, id: number): FixDelivery | null {
  const row = store.db.prepare('SELECT * FROM fix_deliveries WHERE id = ?').get(id) as
    | FixDeliveryRow
    | undefined;
  return row === undefined ? null : rowToDelivery(row);
}

/** The latest (highest id) non-superseded row of a ticket, or null. */
export function currentFixDelivery(store: Store, ticketId: number): FixDelivery | null {
  const row = store.db
    .prepare(
      `SELECT * FROM fix_deliveries
        WHERE ticket_id = ? AND superseded_at IS NULL
        ORDER BY id DESC LIMIT 1`,
    )
    .get(ticketId) as FixDeliveryRow | undefined;
  return row === undefined ? null : rowToDelivery(row);
}

/** Every open (unread, un-superseded) delivery of a project: the sweep's worklist. */
export function listOpenFixDeliveries(store: Store, projectId: number): FixDelivery[] {
  const rows = store.db
    .prepare(
      `SELECT * FROM fix_deliveries
        WHERE project_id = ? AND read_at IS NULL AND superseded_at IS NULL
        ORDER BY id`,
    )
    .all(projectId) as FixDeliveryRow[];
  return rows.map(rowToDelivery);
}

/** Stamp one row superseded (an interrupted round is never pointed at). */
export function supersedeFixDelivery(store: Store, id: number, at: string): boolean {
  const info = store.db
    .prepare('UPDATE fix_deliveries SET superseded_at = ? WHERE id = ? AND superseded_at IS NULL')
    .run(at, id);
  return Number(info.changes) > 0;
}

/** Stamp every unread, live row of a ticket superseded; returns rows changed. */
export function supersedeFixDeliveries(store: Store, ticketId: number, at: string): number {
  const info = store.db
    .prepare(
      `UPDATE fix_deliveries SET superseded_at = ?
        WHERE ticket_id = ? AND read_at IS NULL AND superseded_at IS NULL`,
    )
    .run(at, ticketId);
  return Number(info.changes);
}

type StampColumn =
  | 'armed_at'
  | 'enqueued_at'
  | 'pointed_at'
  | 'repointed_at'
  | 'pointer_failed_at';

function claimColumn(store: Store, column: StampColumn, id: number, at: string): boolean {
  const info = store.db
    .prepare(`UPDATE fix_deliveries SET ${column} = ? WHERE id = ? AND ${column} IS NULL`)
    .run(at, id);
  return Number(info.changes) > 0;
}

export const claimArmed = (store: Store, id: number, at: string): boolean =>
  claimColumn(store, 'armed_at', id, at);
export const claimEnqueued = (store: Store, id: number, at: string): boolean =>
  claimColumn(store, 'enqueued_at', id, at);
export const claimPointed = (store: Store, id: number, at: string): boolean =>
  claimColumn(store, 'pointed_at', id, at);
export const claimRepointed = (store: Store, id: number, at: string): boolean =>
  claimColumn(store, 'repointed_at', id, at);
export const claimPointerFailed = (store: Store, id: number, at: string): boolean =>
  claimColumn(store, 'pointer_failed_at', id, at);

/** The queue dropped a typed line: free the in-flight claim so the sweep can retry. */
export function clearEnqueued(store: Store, id: number): boolean {
  const info = store.db
    .prepare('UPDATE fix_deliveries SET enqueued_at = NULL WHERE id = ? AND enqueued_at IS NOT NULL')
    .run(id);
  return Number(info.changes) > 0;
}

/** The receipt: first claim wins. */
export function claimRead(store: Store, id: number, via: FixDeliveredVia, at: string): boolean {
  const info = store.db
    .prepare('UPDATE fix_deliveries SET read_at = ?, delivered_via = ? WHERE id = ? AND read_at IS NULL')
    .run(at, via, id);
  return Number(info.changes) > 0;
}

/** A confirmed seed launch delivered the brief: mark the row of that launch read. */
export function markSeedRead(store: Store, launchId: string, at: string): boolean {
  const info = store.db
    .prepare(
      `UPDATE fix_deliveries SET read_at = ?, delivered_via = 'seed'
        WHERE launch_id = ? AND read_at IS NULL AND superseded_at IS NULL`,
    )
    .run(at, launchId);
  return Number(info.changes) > 0;
}

/**
 * The session generation changed with no fix relaunch (resume/switch/adopt):
 * move the SAME delivery to the new generation with a fresh clock. Compare-and-
 * swap on the old launch id (NULL-safe), so a second window's re-arm is a no-op.
 */
export function rearmFixDelivery(
  store: Store,
  id: number,
  input: { from: string | null; to: string; armed: boolean; at: string },
): boolean {
  const info = store.db
    .prepare(
      `UPDATE fix_deliveries
          SET launch_id = ?, armed_at = ?, enqueued_at = NULL, pointed_at = NULL,
              repointed_at = NULL, pointer_failed_at = NULL
        WHERE id = ? AND launch_id IS ? AND read_at IS NULL`,
    )
    .run(input.to, input.armed ? input.at : null, id, input.from);
  return Number(info.changes) > 0;
}
