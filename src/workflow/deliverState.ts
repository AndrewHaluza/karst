import type { Store } from '../store/db.js';
import { sendBackState, type SendBackUnavailableReason } from './sendBack.js';

/**
 * "Deliver to PR": the ship-stage action that puts a manual fix session's
 * commits on the open PR. It rides on `sendBackState` (in-flight and landed
 * refusals stay shared) and needs an open PR to deliver into. How many commits
 * are undelivered is host-measured on the PR refresh (`UndeliveredTracker`),
 * never derived here.
 */
export type DeliverUnavailableReason = SendBackUnavailableReason | 'no-open-pr';

export interface DeliverPr {
  repo: string;
  number: number | null;
  /** The PR's head branch. */
  branch: string;
  /** The repo's ticket worktree. */
  cwd: string;
}

export type DeliverTargets =
  | { available: true; prs: readonly DeliverPr[] }
  | { available: false; reason: DeliverUnavailableReason };

interface OpenPrRow {
  repo: string;
  number: number | null;
  head_ref: string | null;
  cwd: string | null;
}

export function deliverTargets(store: Store, ticketId: number): DeliverTargets {
  const sb = sendBackState(store, ticketId);
  if (!sb.available) return { available: false, reason: sb.reason };
  if (sb.stage !== 'ship') return { available: false, reason: 'stage' };
  const rows = store.db
    .prepare(
      `SELECT p.repo, p.number, p.head_ref,
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
  const prs = rows.flatMap((r) =>
    r.head_ref && r.cwd ? [{ repo: r.repo, number: r.number, branch: r.head_ref, cwd: r.cwd }] : [],
  );
  return prs.length === 0 ? { available: false, reason: 'no-open-pr' } : { available: true, prs };
}
