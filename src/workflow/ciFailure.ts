import type { Store } from '../store/db.js';
import { parseChecks, type FailingCheck } from '../model/prChecks.js';
import { sendBackState, type SendBackUnavailableReason } from './sendBack.js';

/**
 * "Send CI failure to agent": the availability rule for the ship-stage action.
 *
 * It rides on `sendBackState` (not a copy of it), so the in-flight and landed
 * refusals can never drift from the plain send-back. On top it needs the STORED
 * rollup (`prs.checks`, written by prSync) to say a current open PR is failing,
 * and no current open PR to still be pending: a pending rollup means CI is
 * running on a head whose result is not known yet, and the stored failure may
 * belong to the head before a push or rebase.
 */
export type CiFailureUnavailableReason = SendBackUnavailableReason | 'not-failing' | 'pending';

export interface CiFailurePr {
  repo: string;
  number: number | null;
  url: string;
  /** gh's cwd for the repo (a worktree path). */
  cwd: string;
  failing: readonly FailingCheck[];
}

export type CiFailureState =
  | { available: true; prs: readonly CiFailurePr[] }
  | { available: false; reason: CiFailureUnavailableReason };

interface OpenPrRow {
  repo: string;
  number: number | null;
  url: string;
  checks: string | null;
  cwd: string;
}

/** The repo's current open, undismissed PRs with a worktree to run gh in. */
function openPrRows(store: Store, ticketId: number): OpenPrRow[] {
  return store.db
    .prepare(
      `SELECT p.repo, p.number, p.url, p.checks,
              (SELECT w.path FROM worktrees w WHERE w.ticket_id = p.ticket_id AND w.repo = p.repo
                ORDER BY w.rowid DESC LIMIT 1) AS cwd
         FROM prs p
        WHERE p.ticket_id = ? AND p.url IS NOT NULL AND p.status = 'open' AND p.dismissed_at IS NULL
          AND p.rowid = (SELECT q.rowid FROM prs q WHERE q.ticket_id = p.ticket_id AND q.repo = p.repo
                          AND q.url IS NOT NULL
                          ORDER BY CASE WHEN q.status = 'open' THEN 0 ELSE 1 END, q.number DESC LIMIT 1)
        ORDER BY p.repo`,
    )
    .all(ticketId) as OpenPrRow[];
}

export function ciFailureState(store: Store, ticketId: number): CiFailureState {
  const sb = sendBackState(store, ticketId);
  if (!sb.available) return { available: false, reason: sb.reason };
  if (sb.stage !== 'ship') return { available: false, reason: 'stage' };
  const prs: CiFailurePr[] = [];
  for (const row of openPrRows(store, ticketId)) {
    const checks = parseChecks(row.checks);
    if (checks?.state === 'pending') return { available: false, reason: 'pending' };
    if (checks?.state === 'failing' && row.cwd) {
      prs.push({ repo: row.repo, number: row.number, url: row.url, cwd: row.cwd, failing: checks.failing });
    }
  }
  return prs.length === 0 ? { available: false, reason: 'not-failing' } : { available: true, prs };
}
