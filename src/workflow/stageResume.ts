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
 * instead of clearing WHILE its run is still blocked: the graph needs
 * graph-aware recovery, and clearing the block would strand the graph's stage
 * signal (Slice-3 Task 9). Once no blocked run stands behind it the block is
 * stale evidence and clears like any other. This module holds NO graph logic —
 * it only recognizes the blocker kind and asks `graphMarkerGuard` whether a
 * recoverable run still exists.
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
  // Same reasoning as `awaiting-merge`: the question was asked (the graph
  // finished) and answered "not yet". Clearing it here would strand the
  // ticket the same way — `markGraphAwaitingImplMarker`'s own guard clears it
  // the moment the marker actually fires, which a generic Resume can't do.
  if (block.kind === 'awaiting-impl-marker') return { kind: 'refused' };
  if (block.kind === 'approach-graph-failed') {
    const graphRunId = blockedGraphRunFor(store, panelTicketId);
    // No blocked run behind the block means its evidence is STALE: the run it
    // describes was stopped, cancelled or swept, so graph-aware recovery has
    // nothing to recover and every recovery exit is gone. Refusing here left
    // the banner on the stage forever with no control able to close it (the
    // reported dead end after a Stop). A stale block is exactly what Resume's
    // "karst could not ask the question, retry it" clear is for.
    if (graphRunId === undefined) {
      clearStageBlock(store, panelTicketId, stageKey);
      return { kind: 'cleared' };
    }
    return { kind: 'graph-recovery', ticketId: panelTicketId, graphRunId };
  }
  clearStageBlock(store, panelTicketId, stageKey);
  return { kind: 'cleared' };
}
