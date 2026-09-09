import type { Store } from '../store/db.js';
import { buildConflictBrief } from '../workflow/conflictSession.js';
import { resolveTicketByKey } from './resolveTicket.js';

/**
 * The `karst conflict-brief <key> <repo>` CLI verb — human-readable summary
 * of the merge conflict a session must resolve. Read-only; never mutates the
 * store.
 *
 *   grammar: `['conflict-brief', <key>, <repo>]`, no flags.
 *   returns: prose brief or the "nothing to resolve" line; never throws on null.
 */

/**
 * Compose the shell command prefix embedded in the generated resolve-conflict
 * command — the agent appends the ticket key and repo, then runs it to get
 * the merge-conflict brief. Paths are double-quoted so spaces survive. Pure
 * (no fs) so it is testable.
 */
export function composeConflictBriefCommand(
  cliEntry: string,
  dbPath: string,
  manifestPath?: string,
): string {
  const q = (s: string): string => `"${s}"`;
  const parts = ['node', q(cliEntry), 'conflict-brief', '--db', q(dbPath)];
  if (manifestPath) parts.push('--manifest', q(manifestPath));
  return parts.join(' ');
}

export interface ParsedConflictBrief {
  key: string;
  repo: string;
}

/**
 * Parse `['conflict-brief', <key>, <repo>]`. Fails fast on anything malformed.
 */
export function parseConflictBriefArgs(argv: string[]): ParsedConflictBrief {
  const [cmd, key, repo, ...rest] = argv;
  if (cmd !== 'conflict-brief') {
    throw new Error(`expected 'conflict-brief' command, got '${cmd ?? ''}'`);
  }
  if (!key || key.startsWith('-')) {
    throw new Error('missing ticket key (usage: conflict-brief <key> <repo>)');
  }
  if (!repo || repo.startsWith('-')) {
    throw new Error('missing repo (usage: conflict-brief <key> <repo>)');
  }
  if (rest.length > 0) {
    throw new Error(`unexpected argument '${rest[0]!}' (usage: conflict-brief <key> <repo>)`);
  }
  return { key, repo };
}

/**
 * Resolve the ticket by key, build the conflict brief, and return prose. Throws
 * when the key is unknown. Returns the "nothing to resolve" line when the repo
 * is not conflicted — a valid answer, not an error.
 */
export function runConflictBriefCommand(store: Store, parsed: ParsedConflictBrief): string {
  const found = resolveTicketByKey(store, parsed.key, undefined);
  if (!found) {
    throw new Error(`no ticket found for key or id '${parsed.key}'`);
  }
  const brief = buildConflictBrief(store, found.id, parsed.repo);
  if (brief === null) {
    return `No merge conflict is recorded for "${parsed.repo}" on this ticket — nothing to resolve.`;
  }
  return brief;
}
