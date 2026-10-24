import type { Store } from '../store/db.js';
import { getTicket, setStageCurrent } from '../store/tickets.js';
import { ensureStage, removeStage, setStage } from '../store/stages.js';
import { nowIso } from '../model/time.js';

/**
 * Closing a ticket records that it was resolved OUTSIDE karst (a teammate did it
 * by hand, an agent session ran without karst). It is an operator assertion, not
 * a verdict: nothing is verified, and `done` ("every PR merged") keeps meaning
 * what it says. The only entry to `closed`, deliberately not a `STAGE_GRAPH`
 * edge, so `transition()`'s "missing edge throws" rule is untouched.
 *
 * The reason (and optional ref, stored but never trusted) lives on the closed
 * stage row's `verdict`; the stages the ticket passed through stay as history.
 */
export interface CloseInput {
  reason: string;
  ref?: string;
}

export function closeTicket(store: Store, ticketId: number, input: CloseInput): void {
  const reason = input.reason.trim();
  if (reason === '') throw new Error('closing a ticket requires a reason');
  const ref = input.ref?.trim();

  store.db.transaction(() => {
    const { stageCurrent } = getTicket(store, ticketId);
    if (stageCurrent === 'done' || stageCurrent === 'closed') {
      throw new Error(`ticket ${ticketId} is already ${stageCurrent}`);
    }
    ensureStage(store, ticketId, 'closed');
    const at = nowIso();
    setStage(store, ticketId, 'closed', {
      status: 'passed',
      verdict: ref ? `${reason} (${ref})` : reason,
      startedAt: at,
      endedAt: at,
    });
    setStageCurrent(store, ticketId, 'closed');
  })();
}

/** Undo a close: back to a running `impl`, the closed row dropped. */
export function reopenTicket(store: Store, ticketId: number): void {
  store.db.transaction(() => {
    if (getTicket(store, ticketId).stageCurrent !== 'closed') {
      throw new Error(`ticket ${ticketId} is not closed`);
    }
    removeStage(store, ticketId, 'closed');
    setStage(store, ticketId, 'impl', {
      status: 'running',
      verdict: null,
      startedAt: nowIso(),
      endedAt: null,
    });
    setStageCurrent(store, ticketId, 'impl');
  })();
}
