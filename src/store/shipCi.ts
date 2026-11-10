import type { Store } from './db.js';
import { CURRENT_PR_ORDER } from './prs.js';
import { listMergeChecksByTicket } from './mergeChecks.js';
import { getAutopilotTicket } from './autopilot.js';
import { parseChecks, readMergeBlock, type ChecksState, type MergeBlock } from '../model/prChecks.js';

/**
 * The derived "CI running" reading of a shipped ticket (@arch:BLOCKED). It is
 * computed on read, never stored: the `awaiting-merge` block stays on the ship
 * stage, and only the needs-you READING yields while mandatory CI runs.
 */
export type ShipCi = 'running' | null;

/** One current open PR, reduced to the two facts the reading needs. */
export interface ShipCiPr {
  checks: ChecksState | null;
  mergeBlock: MergeBlock;
}

/**
 * Pure rule. CI "runs" when at least one PR has a pending check that GitHub
 * still counts as blocking (`merge_block` is not `clean`), and nothing already
 * needs the user: no failing PR, no `dirty` PR, no conflicted merge check.
 * `unknown` never counts as pending.
 */
export function shipCiReading(prs: readonly ShipCiPr[], hasConflict: boolean): ShipCi {
  if (hasConflict || prs.length === 0) return null;
  if (prs.some((p) => p.checks === 'failing' || p.mergeBlock === 'dirty')) return null;
  return prs.some((p) => p.checks === 'pending' && p.mergeBlock !== 'clean') ? 'running' : null;
}

interface CurrentOpenPrRow {
  checks: string | null;
  merge_block: string | null;
}

/** The CURRENT open, not dismissed PR of each repo — the rows the merge gate reads. */
function listCurrentOpenPrs(store: Store, ticketId: number): ShipCiPr[] {
  const rows = store.db
    .prepare(
      `SELECT pr.checks, pr.merge_block
         FROM prs pr
        WHERE pr.ticket_id = ?
          AND pr.url IS NOT NULL
          AND pr.status = 'open'
          AND pr.dismissed_at IS NULL
          AND pr.rowid = (SELECT p.rowid
                            FROM prs p
                           WHERE p.ticket_id = pr.ticket_id
                             AND p.repo = pr.repo
                             AND p.url IS NOT NULL
                           ${CURRENT_PR_ORDER}
                           LIMIT 1)`,
    )
    .all(ticketId) as CurrentOpenPrRow[];
  return rows.map((r) => ({
    checks: parseChecks(r.checks)?.state ?? null,
    mergeBlock: readMergeBlock(r.merge_block),
  }));
}

/** Read the reading for one ticket that is already known to wait at ship's awaiting-merge. */
export function readShipCi(store: Store, ticketId: number): ShipCi {
  const autopilot = getAutopilotTicket(store, ticketId);
  // An autopilot park uses the same awaiting-merge kind and must stay amber.
  if (autopilot.stoppedReason !== null || autopilot.pausedReason !== null) return null;
  const hasConflict = listMergeChecksByTicket(store, ticketId).some((m) => m.state === 'conflicted');
  return shipCiReading(listCurrentOpenPrs(store, ticketId), hasConflict);
}

/** Whether a loaded ticket can read "CI running" at all: ship, awaiting-merge, not paused. */
export function isShipAwaitingMerge(t: {
  stageCurrent: string | null;
  pausedAt: string | null;
  stages: readonly { stageKey: string; blockedKind?: string | null }[];
}): boolean {
  if (t.stageCurrent !== 'ship' || t.pausedAt != null) return false;
  return t.stages.some((s) => s.stageKey === 'ship' && s.blockedKind === 'awaiting-merge');
}
