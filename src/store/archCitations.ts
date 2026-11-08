import type { Store } from './db.js';
import type { ArchCitation } from '../model/archCitations.js';

/**
 * Arch citations (v107, @arch:CLI-22): one row per ticket and arch key, the
 * reason an agent gave for why a covered block still holds. Store-only — the same
 * functions serve the extension's better-sqlite3 store and the CLI's node:sqlite
 * shim. Re-citing a key replaces its reason.
 */

/** The DDL schema.sql mirrors for a fresh DB (the v107 migration step execs it). */
export const ARCH_CITATIONS_DDL = `
CREATE TABLE IF NOT EXISTS arch_citations (
  ticket_id  INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  key        TEXT NOT NULL,
  reason     TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (ticket_id, key)
);
`;

/** Record (or replace) the ticket's citation for one key. */
export function upsertArchCitation(store: Store, ticketId: number, citation: ArchCitation): { replaced: boolean } {
  const prior = store.db
    .prepare('SELECT 1 AS hit FROM arch_citations WHERE ticket_id = ? AND key = ?')
    .get(ticketId, citation.key) as { hit: number } | undefined;
  store.db
    .prepare(
      `INSERT INTO arch_citations (ticket_id, key, reason, updated_at) VALUES (?, ?, ?, datetime('now'))
       ON CONFLICT (ticket_id, key) DO UPDATE SET reason = excluded.reason, updated_at = excluded.updated_at`,
    )
    .run(ticketId, citation.key, citation.reason);
  return { replaced: prior !== undefined };
}

/** The ticket's citations, ordered by key. */
export function listArchCitations(store: Store, ticketId: number): ArchCitation[] {
  const rows = store.db
    .prepare('SELECT key, reason FROM arch_citations WHERE ticket_id = ? ORDER BY key')
    .all(ticketId) as Array<{ key: string; reason: string }>;
  return rows.map((r) => ({ key: r.key, reason: r.reason }));
}
