import type { Store } from '../../store/db.js';
import { getTicket } from '../../store/tickets.js';
import { stageBlock } from '../../store/stageBlocks.js';
import { claimStallSuggestion, failStallSuggestion, getStallSuggestion } from '../../store/stallSuggestions.js';
import type { TicketDiff } from './stallDiff.js';

export interface StallSuggestionServiceDeps {
  store: Store;
  /** The ticket's live diff, or null when it cannot be read. */
  readDiff: (ticketId: number) => Promise<TicketDiff | null>;
  /** One generation for one park (see `generateStallSuggestion`). */
  generate: (ticketId: number, parkAt: string, diff: TicketDiff, retry: boolean) => Promise<unknown>;
  /** Repaint the panel and the sidebar. */
  refresh: (ticketId: number) => void;
  debug?: (message: string) => void;
  /** The clock for a failure row; defaults to the system time. */
  now?: () => string;
}

export interface StallSuggestionService {
  /**
   * Make sure the current park has a suggestion. Safe to call often: it is a
   * no-op for a ticket that is not parked as review-stalled, for a park that
   * already has an answer, and while a run for the park is in flight.
   * It never rejects.
   */
  ensure: (ticketId: number, opts?: { retry?: boolean }) => Promise<void>;
}

const EMPTY_DIFF: TicketDiff = { files: [], stat: '' };

export function createStallSuggestionService(deps: StallSuggestionServiceDeps): StallSuggestionService {
  const inFlight = new Set<string>();
  return {
    async ensure(ticketId, opts) {
      const retry = opts?.retry === true;
      const block = getTicket(deps.store, ticketId).stageCurrent === 'fix' ? stageBlock(deps.store, ticketId, 'fix') : null;
      if (block === null || block.kind !== 'review-stalled' || block.at === '') return;
      const key = `${ticketId}:${block.at}`;
      if (inFlight.has(key)) return;
      const row = getStallSuggestion(deps.store, ticketId, block.at);
      if (row !== null && !retry && row.status !== 'generating') return;
      inFlight.add(key);
      try {
        const diff = (await deps.readDiff(ticketId)) ?? EMPTY_DIFF;
        await deps.generate(ticketId, block.at, diff, retry);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        deps.debug?.(`[stall-suggestion] ticket ${ticketId}: ${message}`);
        // A throw before the call wrote a row would leave the panel on "generating" for good.
        const row = getStallSuggestion(deps.store, ticketId, block.at);
        if (row === null || row.status === 'generating') {
          const at = (deps.now ?? (() => new Date().toISOString()))();
          claimStallSuggestion(deps.store, ticketId, block.at, at, true);
          failStallSuggestion(deps.store, ticketId, block.at, message, false, at);
        }
      } finally {
        inFlight.delete(key);
        deps.refresh(ticketId);
      }
    },
  };
}
