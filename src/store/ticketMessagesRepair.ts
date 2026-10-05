import type { Database } from 'better-sqlite3';

/**
 * Bring `ticket_messages` to its current v64 shape on a DB already stamped 64.
 *
 * v64 is unreleased; it shipped on the sub-task branch before the wake claim
 * (`woke_at`) and AUTOINCREMENT ids (the delivery sweep's id watermarks must
 * never see a deleted top row's id reused). The version gate cannot repair a
 * DB already at 64, so this reads the CURRENT table and rebuilds it once —
 * rows kept, ids kept — then ensures the indexes. Idempotent; a no-op when
 * the table is absent or already current. Caller owns the transaction.
 */
export const TICKET_MESSAGES_DDL = `
  CREATE TABLE IF NOT EXISTS ticket_messages (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id     INTEGER REFERENCES projects(id) ON DELETE CASCADE,
    from_ticket_id INTEGER REFERENCES tickets(id) ON DELETE CASCADE,
    to_ticket_id   INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    kind           TEXT NOT NULL CHECK (kind IN ('message', 'event')),
    body           TEXT NOT NULL,
    created_at     TEXT NOT NULL DEFAULT (datetime('now')),
    read_at        TEXT,
    woke_at        TEXT
  )`;

const INDEXES = [
  'CREATE INDEX IF NOT EXISTS idx_ticket_messages_inbox ON ticket_messages(to_ticket_id, read_at)',
  'CREATE INDEX IF NOT EXISTS idx_ticket_messages_wake ON ticket_messages(project_id, kind, woke_at, id)',
];

const KEPT = 'id, project_id, from_ticket_id, to_ticket_id, kind, body, created_at, read_at';

function tableSql(db: Database): string | undefined {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'ticket_messages'")
    .get() as { sql: string } | undefined;
  return row?.sql;
}

/** Whether the table exists in a pre-current shape. */
export function ticketMessagesNeedsRepair(db: Database): boolean {
  const sql = tableSql(db);
  if (sql === undefined) return false;
  if (!/AUTOINCREMENT/i.test(sql) || !/\bwoke_at\b/.test(sql)) return true;
  const idx = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_ticket_messages_wake'")
    .get();
  return idx === undefined;
}

export function repairTicketMessages(db: Database): void {
  const sql = tableSql(db);
  if (sql === undefined) return;
  if (!/AUTOINCREMENT/i.test(sql) || !/\bwoke_at\b/.test(sql)) {
    const hasWoke = /\bwoke_at\b/.test(sql);
    db.exec('ALTER TABLE ticket_messages RENAME TO ticket_messages_old');
    db.exec('DROP INDEX IF EXISTS idx_ticket_messages_inbox');
    db.exec('DROP INDEX IF EXISTS idx_ticket_messages_wake');
    db.exec(TICKET_MESSAGES_DDL);
    db.exec(
      `INSERT INTO ticket_messages (${KEPT}, woke_at)
       SELECT ${KEPT}, ${hasWoke ? 'woke_at' : 'NULL'} FROM ticket_messages_old`,
    );
    db.exec('DROP TABLE ticket_messages_old');
  }
  for (const stmt of INDEXES) db.exec(stmt);
}
