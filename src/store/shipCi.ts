import type { Store } from './db.js';
import { CURRENT_PR_ORDER } from './prs.js';
import { currentDeliverRun } from './deliverRuns.js';
import { listMergeChecksByTicket } from './mergeChecks.js';
import { getAutopilotTicket } from './autopilot.js';
import { parseChecks, readMergeBlock, type ChecksState, type MergeBlock, type PrChecks } from '../model/prChecks.js';

/**
 * The derived "CI running" reading of a shipped ticket (@arch:BLOCKED). It is
 * computed on read, never stored: the `awaiting-merge` block stays on the ship
 * stage, and only the needs-you READING yields while mandatory CI runs.
 * Optional-only failures do not cancel it (see `optionalFailureOnly`).
 */
export type ShipCi = 'running' | null;

/** One current open PR, reduced to the facts the reading needs. */
export interface ShipCiPr {
  checks: ChecksState | null;
  mergeBlock: MergeBlock;
  /** The stored rollup, for the optional-failure rule; absent = no detail (a failure stays amber). */
  rollup?: PrChecks | null;
}

/**
 * A failing PR whose every failure is KNOWN optional while required checks still run: GitHub gave the
 * required split, none of the required checks failed, some are pending, every failure says
 * `required === false`, and the failing list is complete. Anything unknown keeps the PR amber (@arch:GH-03).
 * `isKnownOptional` needs 0 required pending, so it cannot answer here.
 */
function optionalFailureOnly(p: ShipCiPr): boolean {
  const c = p.rollup;
  if (!c || c.state !== 'failing' || c.required == null) return false;
  if (c.required.failed !== 0 || c.required.pending <= 0) return false;
  if (c.failing.length === 0 || c.failedShown < c.failed || c.failing.length < c.failed) return false;
  return c.failing.every((f) => f.required === false) && p.mergeBlock === CI_BLOCKING;
}

/**
 * Pure rule. CI "runs" when at least one PR has a pending check that GitHub
 * still counts as blocking (`merge_block` is `blocked`), and nothing already
 * needs the user: no failing PR, no `dirty` PR, no conflicted merge check.
 * `unknown` never counts as pending.
 */
export function shipCiReading(prs: readonly ShipCiPr[], hasConflict: boolean): ShipCi {
  if (hasConflict || prs.length === 0) return null;
  if (prs.some((p) => (p.checks === 'failing' && !optionalFailureOnly(p)) || p.mergeBlock === 'dirty')) return null;
  const runs = (p: ShipCiPr): boolean => (p.checks === 'pending' && p.mergeBlock === CI_BLOCKING) || optionalFailureOnly(p);
  return prs.some(runs) ? 'running' : null;
}

/**
 * The one `merge_block` token that means "GitHub refuses the merge until the
 * required checks end". Every other token either permits the merge now (`clean`,
 * `unstable`, `has_hooks`) or waits on a user action (`behind`, `draft`,
 * `dirty`), and `unknown` is a non-answer — all of them keep the ticket amber.
 */
const CI_BLOCKING: MergeBlock = 'blocked';

let shipCiDebug: ((message: string) => void) | undefined;

/** Composition-root seam: the host injects its debug sink once at activation. */
export function setShipCiDebug(debug: ((message: string) => void) | undefined): void {
  shipCiDebug = debug;
}

/** Log a failed read; the reading itself falls back to null (amber). */
export function reportShipCiFailure(ticketId: number, err: unknown): void {
  shipCiDebug?.(`[merge] shipCi read failed for ticket ${ticketId}: ${err instanceof Error ? err.message : String(err)}`);
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
    rollup: parseChecks(r.checks),
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

/** Whether the ticket's current deliver run runs now (derived at load, never stored). */
export function readDeliverRunning(store: Store, ticketId: number): boolean {
  return currentDeliverRun(store, ticketId)?.state === 'running';
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
