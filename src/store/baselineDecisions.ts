import type { Store } from './db.js';

/**
 * Append-only record of the USER's verdict on a changed baseline file
 * (@arch:BASELINE-REVIEW). A path counts as approved only while its LATEST row
 * is `approved` for the sha256 the worktree still has — an agent re-recording
 * the file changes the sha, so the approval lapses without anyone clearing it.
 * Rows are never updated or deleted (a rejection stays as evidence).
 */

/** The DDL schema.sql mirrors for a fresh DB (the v75 migration step execs it). */
export const BASELINE_DECISIONS_DDL = `
CREATE TABLE IF NOT EXISTS baseline_decisions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id  INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  repo       TEXT NOT NULL,
  path       TEXT NOT NULL,
  sha256     TEXT NOT NULL,
  decision   TEXT NOT NULL CHECK (decision IN ('approved', 'rejected')),
  reason     TEXT,
  decided_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_baseline_decisions_ticket
  ON baseline_decisions(ticket_id, repo, path, id);
`;

export type BaselineDecisionKind = 'approved' | 'rejected';

export interface BaselineDecisionInput {
  repo: string;
  path: string;
  sha256: string;
  decision: BaselineDecisionKind;
  reason: string | null;
}

export interface BaselineDecision {
  sha256: string;
  decision: BaselineDecisionKind;
  reason: string | null;
  decidedAt: string;
}

/** Map key for a (repo, path) pair. */
export function baselineKey(repo: string, path: string): string {
  return `${repo}\0${path}`;
}

/** Append a batch in ONE transaction: all rows land or none do. */
export function recordBaselineDecisions(
  store: Store,
  ticketId: number,
  rows: readonly BaselineDecisionInput[],
  decidedAt: string,
): void {
  const insert = store.db.prepare(
    `INSERT INTO baseline_decisions (ticket_id, repo, path, sha256, decision, reason, decided_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  store.db.transaction(() => {
    for (const row of rows) {
      insert.run(ticketId, row.repo, row.path, row.sha256, row.decision, row.reason, decidedAt);
    }
  })();
}

/** The most recent decision per (repo, path) for a ticket, keyed by `baselineKey`. */
export function latestBaselineDecisions(
  store: Store,
  ticketId: number,
): Map<string, BaselineDecision> {
  const rows = store.db
    .prepare(
      `SELECT repo, path, sha256, decision, reason, decided_at FROM baseline_decisions
       WHERE ticket_id = ? ORDER BY id ASC`,
    )
    .all(ticketId) as Array<{
    repo: string;
    path: string;
    sha256: string;
    decision: BaselineDecisionKind;
    reason: string | null;
    decided_at: string;
  }>;
  const latest = new Map<string, BaselineDecision>();
  for (const row of rows) {
    latest.set(baselineKey(row.repo, row.path), {
      sha256: row.sha256,
      decision: row.decision,
      reason: row.reason,
      decidedAt: row.decided_at,
    });
  }
  return latest;
}
