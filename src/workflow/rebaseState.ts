import type { Store } from '../store/db.js';
import type { StageKey } from '../model/types.js';
import { getTicket } from '../store/tickets.js';
import { getStage } from '../store/stages.js';
import { latestStageRun } from '../store/stageRuns.js';
import { listCurrentPrsByTicket } from '../store/prs.js';
import { sendBackState, type SendBackUnavailableReason } from './sendBack.js';

/** Pre-ship stages that offer the action; own set so send-back availability stays untouched. */
const PRE_SHIP_STAGES: readonly StageKey[] = ['impl', 'uat', 'review', 'fix'];

/**
 * "Rebase on base": the availability rule. Ship rides on `sendBackState`
 * (in-flight and landed refusals stay shared) and needs a current open PR the
 * stored probe says is BEHIND its base (`merge_block`). impl/uat/review/fix need
 * only a spun ticket: whether a branch is behind needs a fetch, so the ops checks
 * that and no-ops when already current.
 */
export type RebaseUnavailableReason = SendBackUnavailableReason | 'not-behind' | 'not-spun';

export interface RebasePr {
  repo: string;
  number: number | null;
  /** The PR's head branch, the one to rebase and push. */
  branch: string;
  baseRef: string;
  /** The repo's ticket worktree. */
  cwd: string;
  /** Pre-ship targets: the branch is rebased locally and any PR push is left to ship's lease. */
  preShip?: boolean;
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
  const stage = getTicket(store, ticketId).stageCurrent;
  if (PRE_SHIP_STAGES.includes(stage as StageKey)) return preShipState(store, ticketId, stage as StageKey);
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

interface WorktreeRow {
  repo: string;
  path: string;
  branch: string | null;
  base_ref: string | null;
  pr_number: number | null;
}

function preShipState(store: Store, ticketId: number, stage: StageKey): RebaseState {
  const ticket = getTicket(store, ticketId);
  const runInFlight = latestStageRun(store, ticketId, stage)?.status === 'running';
  const cell = getStage(store, ticketId, stage);
  if (runInFlight || ticket.agentState === 'running' || (cell?.status === 'running' && ticket.agentState === 'running')) {
    return { available: false, reason: 'in-flight' };
  }
  if (listCurrentPrsByTicket(store, ticketId).some((p) => p.status === 'merged')) {
    return { available: false, reason: 'landed' };
  }
  const rows = store.db
    .prepare(
      `SELECT w.repo, w.path, w.branch, w.base_ref,
              (SELECT p.number FROM prs p WHERE p.ticket_id = w.ticket_id AND p.repo = w.repo
                  AND p.url IS NOT NULL AND p.status = 'open' AND p.dismissed_at IS NULL
                ORDER BY p.number DESC LIMIT 1) AS pr_number
         FROM worktrees w
        WHERE w.ticket_id = ?
          AND w.rowid = (SELECT MAX(x.rowid) FROM worktrees x WHERE x.ticket_id = w.ticket_id AND x.repo = w.repo)
        ORDER BY w.repo`,
    )
    .all(ticketId) as WorktreeRow[];
  const prs = rows.flatMap((r) =>
    r.branch && r.base_ref
      ? [{ repo: r.repo, number: r.pr_number, branch: r.branch, baseRef: r.base_ref, cwd: r.path, preShip: true }]
      : [],
  );
  return prs.length === 0 ? { available: false, reason: 'not-spun' } : { available: true, prs };
}
