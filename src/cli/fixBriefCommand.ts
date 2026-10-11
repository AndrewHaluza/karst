import { formatFixBriefNumber } from '../model/entityId.js';
import type { Store } from '../store/db.js';
import { getTicket } from '../store/tickets.js';
import { latestFindingBatch } from '../store/reviewFindings.js';
import { listGateRuns } from '../store/gateRuns.js';
import { activeRecoverySeries } from '../store/recoveryRounds.js';
import { listPrFeedbackForRound } from '../store/prFeedback.js';
import { renderFixBrief } from '../agent/fixBrief.js';
import { resolveTicketByKey } from './resolveTicket.js';
import { currentFixDelivery, claimRead } from '../store/fixDeliveries.js';
import { quoteArg } from '../agent/cliEnv.js';
import { formatTicketRef } from '../model/entityId.js';

/**
 * The `karst fix-brief` CLI verb — human-readable summary of the failing gate
 * that a `fix` session must address. Read-only by default; never mutates.
 *
 *   grammar: `['fix-brief', <key>]`, or `['fix-brief']` with the global
 *            `--ticket <id|key>` (exactly one of the two), plus opt-in `--ack`.
 *   `--ack`: the read receipt (@arch:V77). Prints the STORED snapshot of the
 *            current fix delivery and claims it read. Refused unless the
 *            session's `KARST_TICKET` resolves to the same ticket (CLI-11).
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
  const parts = ['node', quoteArg(cliEntry), 'fix-brief', '--db', quoteArg(dbPath)];
  if (manifestPath) parts.push('--manifest', quoteArg(manifestPath));
  return parts.join(' ');
}

export interface ParsedFixBrief {
  /** The ticket key or id: the positional argument, else the global `--ticket`. */
  key: string;
  /** Opt-in read receipt: serve the stored snapshot and mark it read. */
  ack: boolean;
}

/**
 * Parse `['fix-brief', <key>? , --ack?]`. `ticketFlag` is the global `--ticket`
 * value, which the CLI strips before the subcommand parser sees the argv; it is
 * the alternative spelling of the positional key. Fails fast on anything else.
 */
export function parseFixBriefArgs(argv: string[], ticketFlag?: string): ParsedFixBrief {
  const [cmd, ...args] = argv;
  if (cmd !== 'fix-brief') {
    throw new Error(`expected 'fix-brief' command, got '${cmd ?? ''}'`);
  }
  let ack = false;
  const positional: string[] = [];
  for (const arg of args) {
    if (arg === '--ack') ack = true;
    else if (arg.startsWith('-')) {
      throw new Error(`unexpected argument '${arg}' (usage: fix-brief <key> [--ack])`);
    } else positional.push(arg);
  }
  if (positional.length > 1) {
    throw new Error(`unexpected argument '${positional[1]!}' (usage: fix-brief <key> [--ack])`);
  }
  const key = positional[0];
  if (key !== undefined && ticketFlag !== undefined) {
    throw new Error('give the ticket once: either fix-brief <key> or --ticket <key>, not both');
  }
  const resolved = key ?? ticketFlag;
  if (!resolved) {
    throw new Error('missing ticket key (usage: fix-brief <key> or fix-brief --ticket <key>)');
  }
  return { key: resolved, ack };
}

export interface FixBriefOptions {
  /** The session env's `KARST_TICKET`, read by the caller so tests inject it. */
  sessionTicketKey?: string | undefined;
  /** Manifest project slug used to scope key resolution. */
  projectSlug?: string | undefined;
  now?: () => string;
}

function liveBrief(store: Store, ticketId: number): string {
  const t = getTicket(store, ticketId);
  // A PR-feedback round's brief carries the adopted threads; an ordinary fix
  // (or a ship saga crash, which opens no round) passes nothing.
  const shipRound = activeRecoverySeries(store, t.id, 'ship');
  const brief = renderFixBrief(
    formatTicketRef(t.id, t.key),
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

/**
 * The receipt path: resolve the session's own ticket, refuse a mismatch, then
 * print the current stored snapshot and claim it read. No current row (an
 * untracked seed round, a pre-v77 history) falls back to the live brief and
 * marks nothing.
 */
function ackBrief(store: Store, ticketId: number, options: FixBriefOptions): string {
  if (!options.sessionTicketKey) {
    throw new Error(
      'fix-brief --ack needs KARST_TICKET (the karst session env) — run it from the ticket\'s karst session terminal',
    );
  }
  const session = resolveTicketByKey(store, options.sessionTicketKey, options.projectSlug);
  if (!session) {
    throw new Error(`no ticket found for session KARST_TICKET '${options.sessionTicketKey}'`);
  }
  if (session.id !== ticketId) {
    throw new Error(
      `--ticket resolves to ticket ${ticketId} but this session's KARST_TICKET is '${options.sessionTicketKey}' — ` +
        'refusing: a session may read only its own fix brief',
    );
  }
  const row = currentFixDelivery(store, ticketId);
  if (row === null) return liveBrief(store, ticketId);
  const first = claimRead(store, row.id, 'pointer', (options.now ?? (() => new Date().toISOString()))());
  const head = first ? `karst fix brief ${formatFixBriefNumber(row.id)}:` : `karst fix brief ${formatFixBriefNumber(row.id)} (already read):`;
  return `${head}\n${row.body}`;
}

/**
 * Resolve the ticket, build the fix brief, and return prose. Throws when the
 * key is unknown. Returns the "nothing to fix" line when no gate is failed —
 * a valid answer, not an error. Only `--ack` writes (the receipt claim).
 */
export function runFixBriefCommand(
  store: Store,
  parsed: ParsedFixBrief,
  options: FixBriefOptions = {},
): string {
  const found = resolveTicketByKey(store, parsed.key, options.projectSlug);
  if (!found) {
    throw new Error(`no ticket found for key or id '${parsed.key}'`);
  }
  return parsed.ack ? ackBrief(store, found.id, options) : liveBrief(store, found.id);
}
