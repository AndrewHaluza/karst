import type { Store } from '../store/db.js';
import { sendBackState, type SendBackUnavailableReason } from './sendBack.js';

/**
 * "Rebase on base": the availability rule for the ship-stage action. It rides
 * on `sendBackState` (in-flight and landed refusals stay shared) and needs a
 * current open PR the stored probe says is BEHIND its base (`merge_block`).
 */
export type RebaseUnavailableReason = SendBackUnavailableReason | 'not-behind';

export interface RebasePr {
  repo: string;
  number: number | null;
  /** The PR's head branch, the one to rebase and push. */
  branch: string;
  baseRef: string;
  /** The repo's ticket worktree. */
  cwd: string;
}

export type RebaseState =
  | { available: true; prs: readonly RebasePr[] }
  | { available: false; reason: RebaseUnavailableReason };

interface BehindRow {
  repo: string;
  number: number | null;
  head_ref: string | null;
  base_ref: string | null;
  cwd: string | null;
}

export function rebaseState(store: Store, ticketId: number): RebaseState {
  const sb = sendBackState(store, ticketId);
  if (!sb.available) return { available: false, reason: sb.reason };
  if (sb.stage !== 'ship') return { available: false, reason: 'stage' };
  const rows = store.db
    .prepare(
      `SELECT p.repo, p.number, p.head_ref, p.base_ref,
              (SELECT w.path FROM worktrees w WHERE w.ticket_id = p.ticket_id AND w.repo = p.repo
                ORDER BY w.rowid DESC LIMIT 1) AS cwd
         FROM prs p
        WHERE p.ticket_id = ? AND p.url IS NOT NULL AND p.status = 'open' AND p.dismissed_at IS NULL
          AND p.merge_block = 'behind'
          AND p.rowid = (SELECT q.rowid FROM prs q WHERE q.ticket_id = p.ticket_id AND q.repo = p.repo
                          AND q.url IS NOT NULL
                          ORDER BY CASE WHEN q.status = 'open' THEN 0 ELSE 1 END, q.number DESC LIMIT 1)
        ORDER BY p.repo`,
    )
    .all(ticketId) as BehindRow[];
  const prs = rows.flatMap((r) =>
    r.head_ref && r.base_ref && r.cwd
      ? [{ repo: r.repo, number: r.number, branch: r.head_ref, baseRef: r.base_ref, cwd: r.cwd }]
      : [],
  );
  return prs.length === 0 ? { available: false, reason: 'not-behind' } : { available: true, prs };
}
