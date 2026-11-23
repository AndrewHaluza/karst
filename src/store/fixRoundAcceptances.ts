import type { Store } from './db.js';

/** Kept in sync with the `fix_round_acceptances` block of schema.sql (v137, @arch:AC-66). */
export const FIX_ROUND_ACCEPTANCES_DDL = `
CREATE TABLE IF NOT EXISTS fix_round_acceptances (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  round_id INTEGER NOT NULL REFERENCES recovery_rounds(id) ON DELETE CASCADE,
  source_stage TEXT NOT NULL,
  trigger_kind TEXT NOT NULL,
  items TEXT NOT NULL,
  note TEXT,
  decided_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_fix_round_acceptances_ticket ON fix_round_acceptances(ticket_id, id);
`;

export interface FixRoundAcceptanceInput {
  ticketId: number;
  roundId: number;
  sourceStage: string;
  triggerKind: string;
  /** The open findings, observations or failed gates the user accepted, one line each. */
  items: readonly string[];
  note: string | null;
  decidedAt: string;
}

export interface FixRoundAcceptance extends Omit<FixRoundAcceptanceInput, 'items'> {
  id: number;
  items: string[];
}

/** Append one user decision. Rows are never updated. Returns the row id. */
export function recordFixRoundAcceptance(store: Store, input: FixRoundAcceptanceInput): number {
  const note = input.note === null || input.note.trim() === '' ? null : input.note.trim();
  const r = store.db
    .prepare('INSERT INTO fix_round_acceptances (ticket_id, round_id, source_stage, trigger_kind, items, note, decided_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(input.ticketId, input.roundId, input.sourceStage, input.triggerKind, JSON.stringify(input.items), note, input.decidedAt);
  return Number(r.lastInsertRowid);
}

function parseItems(raw: string): string[] {
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return []; // A damaged row reads as no items, never as a crash.
  }
}

interface AcceptanceRow {
  id: number;
  ticket_id: number;
  round_id: number;
  source_stage: string;
  trigger_kind: string;
  items: string;
  note: string | null;
  decided_at: string;
}

export function listFixRoundAcceptances(store: Store, ticketId: number): FixRoundAcceptance[] {
  const rows = store.db
    .prepare('SELECT id, ticket_id, round_id, source_stage, trigger_kind, items, note, decided_at FROM fix_round_acceptances WHERE ticket_id = ? ORDER BY id')
    .all(ticketId) as AcceptanceRow[];
  return rows.map((r) => ({
    id: r.id, ticketId: r.ticket_id, roundId: r.round_id, sourceStage: r.source_stage,
    triggerKind: r.trigger_kind, items: parseItems(r.items), note: r.note, decidedAt: r.decided_at,
  }));
}
