import type { Store } from './db.js';

/**
 * Append-only record that UAT's gate list PASSED for a given working-tree
 * fingerprint in a given attempt (@arch:BASELINE-REVIEW). After the user
 * approves a baseline the stage re-enters; a matching row means the code under
 * test has not changed since the gates passed, so the (slow) gate list is not
 * run a second time. Any code change alters the fingerprint and runs it in full.
 */

/** The DDL schema.sql mirrors for a fresh DB (the v76 migration step execs it). */
export const UAT_GATE_PASSES_DDL = `
CREATE TABLE IF NOT EXISTS uat_gate_passes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id   INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  attempt     INTEGER NOT NULL,
  fingerprint TEXT NOT NULL,
  run_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_uat_gate_passes_ticket
  ON uat_gate_passes(ticket_id, attempt, fingerprint);
`;

export function recordUatGatePass(
  store: Store,
  input: { ticketId: number; attempt: number; fingerprint: string; runAt: string },
): void {
  store.db
    .prepare('INSERT INTO uat_gate_passes (ticket_id, attempt, fingerprint, run_at) VALUES (?, ?, ?, ?)')
    .run(input.ticketId, input.attempt, input.fingerprint, input.runAt);
}

export function hasUatGatePass(
  store: Store,
  ticketId: number,
  attempt: number,
  fingerprint: string,
): boolean {
  return (
    store.db
      .prepare('SELECT 1 FROM uat_gate_passes WHERE ticket_id = ? AND attempt = ? AND fingerprint = ? LIMIT 1')
      .get(ticketId, attempt, fingerprint) !== undefined
  );
}
