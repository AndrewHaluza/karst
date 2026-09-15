import type { Store } from '../store/db.js';
import { getTicket } from '../store/tickets.js';
import { latestFindingBatch } from '../store/reviewFindings.js';
import { listGateRuns } from '../store/gateRuns.js';
import { activeRecoverySeries } from '../store/recoveryRounds.js';
import { listPrFeedbackForRound } from '../store/prFeedback.js';
import { renderFixBrief } from '../agent/fixBrief.js';
import { resolveTicketByKey } from './resolveTicket.js';

/**
 * The `karst fix-brief <key>` CLI verb — human-readable summary of the failing
 * gate that a `fix` session must address. Read-only; never mutates the store.
 *
 *   grammar: `['fix-brief', <key>]`, no flags.
 *   returns: prose brief or the "nothing to fix" line; never throws on null.
 */

/**
 * Compose the shell command prefix embedded in the generated fix command — the
 * agent appends the ticket key and runs it to get the failing-gate brief.
 * Paths are double-quoted so spaces survive. Pure (no fs) so it is testable.
 */
export function composeFixBriefCommand(
  cliEntry: string,
  dbPath: string,
  manifestPath?: string,
): string {
  const q = (s: string): string => `"${s}"`;
  const parts = ['node', q(cliEntry), 'fix-brief', '--db', q(dbPath)];
  if (manifestPath) parts.push('--manifest', q(manifestPath));
  return parts.join(' ');
}

export interface ParsedFixBrief {
  key: string;
}

/**
 * Parse `['fix-brief', <key>]`. Fails fast on anything malformed.
 */
export function parseFixBriefArgs(argv: string[]): ParsedFixBrief {
  const [cmd, key, ...rest] = argv;
  if (cmd !== 'fix-brief') {
    throw new Error(`expected 'fix-brief' command, got '${cmd ?? ''}'`);
  }
  if (!key || key.startsWith('-')) {
    throw new Error('missing ticket key (usage: fix-brief <key>)');
  }
  if (rest.length > 0) {
    throw new Error(`unexpected argument '${rest[0]!}' (usage: fix-brief <key>)`);
  }
  return { key };
}

/**
 * Resolve the ticket by key, build the fix brief, and return prose. Throws when
 * the key is unknown. Returns the "nothing to fix" line when no gate is failed
 * — a valid answer, not an error.
 */
export function runFixBriefCommand(store: Store, parsed: ParsedFixBrief): string {
  const found = resolveTicketByKey(store, parsed.key, undefined);
  if (!found) {
    throw new Error(`no ticket found for key or id '${parsed.key}'`);
  }
  const t = getTicket(store, found.id);
  // A PR-feedback round's brief carries the adopted threads; an ordinary fix
  // (or a ship saga crash, which opens no round) passes nothing.
  const shipRound = activeRecoverySeries(store, t.id, 'ship');
  const brief = renderFixBrief(
    t.key ?? `#${t.id}`,
    t.stages,
    latestFindingBatch(store, t.id),
    listGateRuns(store, t.id),
    shipRound === null ? undefined : listPrFeedbackForRound(store, t.id, shipRound.id),
  );
  if (brief === null) {
    return 'No failed gate is recorded for this ticket — there is nothing to fix.';
  }
  return brief;
}
