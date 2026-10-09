import type { Store } from '../store/db.js';
import { pauseTicket, unpauseTicket } from '../store/tickets.js';
import { resolveTicketByKey } from './resolveTicket.js';

/**
 * Parse `['pause', <key>]` or `['unpause', <key>]`.
 */
export function parsePauseArgs(argv: string[]): { action: 'pause' | 'unpause'; key: string } {
  const [cmd, key, ...rest] = argv;
  if (cmd !== 'pause' && cmd !== 'unpause') {
    throw new Error(`expected 'pause' or 'unpause' command, got '${cmd ?? ''}'`);
  }
  if (!key || key.startsWith('-')) {
    throw new Error(`missing ticket key (usage: ${cmd} <key>)`);
  }
  if (rest.length > 0) {
    throw new Error(`unexpected argument '${rest[0]}' (usage: ${cmd} <key>)`);
  }
  return { action: cmd, key };
}

export interface RunPauseOptions {
  sessionKey?: string;
  projectSlug?: string;
}

/**
 * Pause or unpause a ticket.
 *
 * Scoped to the session's own ticket and its direct sub-tasks: refuses other tickets.
 */
export function runPauseCommand(
  store: Store,
  argv: string[],
  opts: RunPauseOptions = {},
): string {
  const { action, key } = parsePauseArgs(argv);
  const target = resolveTicketByKey(store, key, opts.projectSlug);
  if (!target) {
    throw new Error(`no ticket found for key or id '${key}'`);
  }

  // Allowed scope: the session's own ticket and its direct sub-tasks.
  if (opts.sessionKey) {
    const sessionTicket = resolveTicketByKey(store, opts.sessionKey, opts.projectSlug);
    if (!sessionTicket) {
      throw new Error(`no ticket found for session key '${opts.sessionKey}'`);
    }
    const isSelf = target.id === sessionTicket.id;
    const isDirectSubtask = target.subtaskParentId === sessionTicket.id;
    if (!isSelf && !isDirectSubtask) {
      throw new Error(
        `refusing: session ticket '${opts.sessionKey}' may only ${action} itself and its direct sub-tasks`,
      );
    }
  }

  if (action === 'pause') {
    pauseTicket(store, target.id);
    return JSON.stringify({ ok: true, ticketId: target.id, paused: true });
  } else {
    unpauseTicket(store, target.id);
    return JSON.stringify({ ok: true, ticketId: target.id, paused: false });
  }
}
