import type { Store } from '../../store/db.js';
import { getTicket } from '../../store/tickets.js';
import { stageBlock } from '../../store/stageBlocks.js';
import { getStallSuggestion } from '../../store/stallSuggestions.js';
import { formatId } from '../../model/entityId.js';
import type { StallSuggestion } from '../../model/stallSuggestion.js';
import { applyStallOption, type StallApplyDeps, type StallApplyRequest } from './stallApplyOps.js';

/** The dashboard actions of a review stall: Apply, Retry and "Stop and ask in planning". */
export interface StallActionDeps extends StallApplyDeps {
  /** Make sure the current park has a suggestion (`retry` forces a new run). */
  ensure: (ticketId: number, opts?: { retry?: boolean }) => Promise<void>;
  /** Open a planning session with this title and first message. */
  startPlanning: (title: string, kickoff: string) => Promise<unknown>;
}

export interface StallActions {
  stallApply: (request: StallApplyRequest) => Promise<void>;
  stallRetry: () => Promise<void>;
  stallPlanning: () => Promise<void>;
}

/** The first message of the planning session: the ticket key and the written suggestion. */
export function stallPlanningKickoff(ticketKey: string, suggestion: StallSuggestion | null): string {
  const lines = [
    `Ticket ${ticketKey} stopped in review: the fix rounds did not clear the blocking findings.`,
    'Help me decide how to answer the stall. Do not change the ticket yourself.',
  ];
  if (suggestion === null) {
    lines.push('Karst has no written suggestion for this stall.');
    return lines.join('\n');
  }
  lines.push(`Likely cause (Karst suggestion): ${suggestion.cause}`, 'Options Karst suggested:');
  suggestion.options.forEach((o, i) => {
    lines.push(`${i + 1}. ${o.label}${o.recommended ? ' (recommended)' : ''}: ${o.note}`);
  });
  return lines.join('\n');
}

export function makeStallActions(deps: StallActionDeps): StallActions {
  const { store, ticketId } = deps;
  return {
    // A refusal rejects with its reason: the dashboard reports it as `action-result`.
    async stallApply(request) {
      const result = await applyStallOption(deps, request);
      if (!result.ok) throw new Error(result.reason);
    },
    async stallRetry() {
      await deps.ensure(ticketId, { retry: true });
    },
    async stallPlanning() {
      const ticket = getTicket(store, ticketId);
      const block = ticket.stageCurrent === 'fix' ? stageBlock(store, ticketId, 'fix') : null;
      const row = block === null ? null : getStallSuggestion(store, ticketId, block.at);
      const suggestion = row !== null && row.status === 'ready' ? row.suggestion : null;
      const label = ticket.key ?? formatId('ticket', ticketId);
      await deps.startPlanning(`Stalled review ${label}`, stallPlanningKickoff(label, suggestion));
    },
  };
}
