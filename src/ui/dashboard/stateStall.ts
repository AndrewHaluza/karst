import type { Store } from '../../store/db.js';
import type { Severity } from '../../manifest/types.js';
import { getTicket } from '../../store/tickets.js';
import { stageBlock } from '../../store/stageBlocks.js';
import { getStallDiff, getStallSuggestion } from '../../store/stallSuggestions.js';
import { isDocsOnlyDiff, openBlockingCount, stallRounds } from '../../workflow/stallSuggestion.js';
import { withAcceptOption, type StallOption } from '../../model/stallSuggestion.js';
import type { StallView } from './stateTypes.js';

/**
 * The review-stall banner's data, read from the store. Null unless the ticket
 * rests at `fix` with a review-stalled park that has a suggestion row. The
 * Accept option is added here, from the stored diff, never from the agent.
 */
export function buildStallView(store: Store, ticketId: number, blockingSeverity: Severity | 'none'): StallView | null {
  const ticket = getTicket(store, ticketId);
  if (ticket.stageCurrent !== 'fix') return null;
  const block = stageBlock(store, ticketId, 'fix');
  if (block === null || block.kind !== 'review-stalled') return null;
  const row = getStallSuggestion(store, ticketId, block.at);
  if (row === null) return null;
  const rounds = stallRounds(store, ticketId, blockingSeverity);
  const diff = getStallDiff(store, ticketId, block.at);
  const base = {
    parkAt: block.at,
    rounds: rounds.map((r) => ({
      attempt: r.attempt,
      runAt: r.runAt,
      findings: r.findings.map((f) => ({ severity: f.severity, file: f.file, line: f.line, title: f.title })),
    })),
    diff: diff === null ? null : { fileCount: diff.files.length, stat: diff.stat },
    current: { description: ticket.description ?? '', acceptanceCheck: ticket.intent ?? '' },
    options: [] as StallOption[],
  };
  if (row.status === 'generating') return { ...base, status: 'generating' };
  if (row.status === 'failed') return { ...base, status: 'failed', error: row.error, usageLimit: row.usageLimit };
  const docsOnly = diff !== null && isDocsOnlyDiff(diff.files);
  const suggestion = docsOnly ? withAcceptOption(row.suggestion, openBlockingCount(rounds)) : row.suggestion;
  return { ...base, status: 'ready', cause: row.suggestion.cause, options: suggestion.options };
}
