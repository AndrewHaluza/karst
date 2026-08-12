import type { Store } from '../store/db.js';
import { getTicket } from '../store/tickets.js';
import { clearStageBlock, stageBlock } from '../store/stageBlocks.js';
import type { StageKey } from '../model/types.js';
import { blockedGraphRunFor, type StageResumeResult } from './graphMarkerGuard.js';

/**
 * Validate and apply a dashboard `stage-resume` request (§ blocked state
 * visible). The webview message carries its own `ticketId`/`stageKey`, but
 * neither is trusted: this is the ONE place both are checked against the
 * ticket the panel actually owns, right before the store is mutated —
 * `extension.ts` stays a thin binding that calls this and, only on
 * `{kind:'cleared'}`, drives the ticket forward.
 *
 * Refuses (`{kind:'refused'}`, mutates nothing) when:
 * - the message names a different ticket than the panel is scoped to — a
 *   crafted message must not reach across tickets;
 * - the ticket has since left the named stage — a stale panel's message must
 *   not resume a stage the ticket is not at;
 * - the named stage carries no block at all — nothing to clear;
 * - the block's kind is `awaiting-merge` — every OTHER `BlockerKind` means
 *   "karst could not ask the question, retry it", which Resume is for. This
 *   one means the question WAS asked (ship opened its PRs) and answered "not
 *   yet"; a retry cannot make a PR merge, so this refuses the same way a
 *   stage-not-found does. Clearing it here anyway would strand the ticket at
 *   `ship`: `settleShipGate` (`workflow/mergeGate.ts`) requires this exact
 *   block to tell "waiting to land" apart from "parked pending the first
 *   confirm click", and once it's gone the merge click, the PR sweep and a
 *   teammate's merge on GitHub all lose the only signal that lets them
 *   recognize this ticket as theirs to settle.
 *
 * An `approach-graph-failed` block returns the typed `graph-recovery` action
 * instead of clearing: the graph needs graph-aware recovery, and clearing the
 * block would strand the graph's stage signal (Slice-3 Task 9). This module
 * holds NO graph logic — it only recognizes the blocker kind it may not
 * clear and returns the typed action defined by `graphMarkerGuard`.
 */
export function resumeBlockedStage(
  store: Store,
  panelTicketId: number,
  msgTicketId: number,
  stageKey: StageKey,
): StageResumeResult {
  if (msgTicketId !== panelTicketId) return { kind: 'refused' };
  const ticket = getTicket(store, panelTicketId);
  if (ticket.stageCurrent !== stageKey) return { kind: 'refused' };
  const block = stageBlock(store, panelTicketId, stageKey);
  if (!block) return { kind: 'refused' };
  if (block.kind === 'awaiting-merge') return { kind: 'refused' };
  if (block.kind === 'approach-graph-failed') {
    const graphRunId = blockedGraphRunFor(store, panelTicketId);
    if (graphRunId === undefined) return { kind: 'refused' };
    return { kind: 'graph-recovery', ticketId: panelTicketId, graphRunId };
  }
  clearStageBlock(store, panelTicketId, stageKey);
  return { kind: 'cleared' };
}
