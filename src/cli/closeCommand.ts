import type { Store } from '../store/db.js';
import { closeTicket, reopenTicket } from '../workflow/closeTicket.js';
import { getTicket } from '../store/tickets.js';
import { resolveTicketByKey } from './resolveTicket.js';

/**
 * `karst close <key> --reason <text> [--ref <text>]` / `karst reopen <key>` — a
 * person records that a ticket was resolved OUTSIDE karst (`@arch:STAGEMACH`).
 *
 * This is NOT an agent verb. The invoking agent reads ticket content it did not
 * author, and `closed` makes a no-delivery claim only a human may assert, so the
 * verb refuses when the session env names a ticket (`KARST_TICKET`) and the MCP
 * surface drops it (`MCP_EXCLUDED_COMMANDS`). Like the other session checks this
 * is attested, not unforgeable (`@arch:CLI-11`): the blast radius is one
 * reversible stage move that `reopen` undoes. Its own parser, like `stage` and
 * `phase`, so no agent-facing parse path ever gains a close branch.
 */
export type ParsedClose =
  | { action: 'close'; key: string; reason: string; ref?: string }
  | { action: 'reopen'; key: string };

export function parseCloseArgs(argv: string[]): ParsedClose {
  const [cmd, key, ...rest] = argv;
  if (cmd !== 'close' && cmd !== 'reopen') {
    throw new Error(`expected 'close' or 'reopen' command, got '${cmd ?? ''}'`);
  }
  if (!key || key.startsWith('-')) {
    throw new Error(`missing ticket key (usage: ${cmd} <key>)`);
  }
  if (cmd === 'reopen') {
    if (rest.length > 0) throw new Error(`unexpected argument '${rest[0]}' (usage: reopen <key>)`);
    return { action: 'reopen', key };
  }
  let reason: string | undefined;
  let ref: string | undefined;
  for (let i = 0; i < rest.length; i += 2) {
    const flag = rest[i];
    const value = rest[i + 1];
    if ((flag !== '--reason' && flag !== '--ref') || value === undefined) {
      throw new Error(`unexpected argument '${flag}' (usage: close <key> --reason <text> [--ref <text>])`);
    }
    if (flag === '--reason') reason = value;
    else ref = value;
  }
  if (reason === undefined) throw new Error('missing --reason <text> (usage: close <key> --reason <text>)');
  return ref === undefined ? { action: 'close', key, reason } : { action: 'close', key, reason, ref };
}

export interface RunCloseOptions {
  /** The session env's `KARST_TICKET`; set means an agent session. */
  sessionKey?: string;
  projectSlug?: string;
}

export function runCloseCommand(store: Store, argv: string[], opts: RunCloseOptions = {}): string {
  const parsed = parseCloseArgs(argv);
  if (opts.sessionKey) {
    throw new Error(
      `refusing: '${parsed.action}' is a human action and cannot run inside an agent session — ask the user to close the ticket`,
    );
  }
  const target = resolveTicketByKey(store, parsed.key, opts.projectSlug);
  if (!target) throw new Error(`no ticket found for key or id '${parsed.key}'`);
  if (parsed.action === 'close') {
    closeTicket(store, target.id, parsed.ref === undefined ? { reason: parsed.reason } : { reason: parsed.reason, ref: parsed.ref });
  } else {
    reopenTicket(store, target.id);
  }
  return JSON.stringify({ ok: true, ticketId: target.id, stage: getTicket(store, target.id).stageCurrent });
}
