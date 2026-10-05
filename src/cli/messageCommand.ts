import type { Store } from '../store/db.js';
import { findTicketById, getTicketsByKey, type Ticket } from '../store/tickets.js';
import { checkMessaging } from '../model/ticketMessaging.js';
import { quoteUntrusted, sanitizeInline } from '../model/messageText.js';
import {
  listInbox,
  markRead,
  postMessage,
  type TicketMessage,
} from '../store/ticketMessages.js';

/**
 * The `karst message send` / `karst inbox` verbs (parent<->child mailbox).
 *
 * A SEPARATE parse path from `stage`/`phase`/`subtask`, on purpose: it accepts
 * only its own flags and never produces a `Verdict`, so a message can carry
 * text but cannot move a ticket. Bodies are untrusted agent prose — they are
 * stored verbatim and, when printed, quoted line by line under a header that
 * names the sender as untrusted so a body cannot forge a frame.
 *
 * Sender identity is `--ticket` (argv), cross-checked by the caller against
 * the session env's `KARST_TICKET`: attested, not unforgeable (cli.md).
 */

export type ParsedMessageArgs =
  | { verb: 'send'; to: string; body: string }
  | { verb: 'inbox'; all: boolean; json: boolean };

function parseSend(rest: string[]): ParsedMessageArgs {
  let to: string | undefined;
  let body: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i]!;
    if (token === '--to') {
      to = rest[++i];
      if (to === undefined) throw new Error('karst message send: --to needs a value');
    } else if (token === '--body') {
      body = rest[++i];
      if (body === undefined) throw new Error('karst message send: --body needs a value');
    } else {
      throw new Error(`unknown flag '${token}' (want --to or --body)`);
    }
  }
  if (to === undefined || to.trim() === '') {
    throw new Error('missing --to (usage: message send --to parent|<child-key> --body <text>)');
  }
  if (body === undefined) {
    throw new Error('missing --body (usage: message send --to parent|<child-key> --body <text>)');
  }
  return { verb: 'send', to: to.trim(), body };
}

function parseInbox(rest: string[]): ParsedMessageArgs {
  let all = false;
  let json = false;
  for (const token of rest) {
    if (token === '--all') all = true;
    else if (token === '--json') json = true;
    else throw new Error(`unknown flag '${token}' (want --all or --json)`);
  }
  return { verb: 'inbox', all, json };
}

/** Parse `['message','send',..flags]` or `['inbox',..flags]`; names the bad token. */
export function parseMessageArgs(argv: string[]): ParsedMessageArgs {
  const [cmd, ...rest] = argv;
  if (cmd === 'inbox') return parseInbox(rest);
  if (cmd === 'message') {
    const [sub, ...flags] = rest;
    if (sub !== 'send') {
      throw new Error(`unknown message subcommand '${sub ?? ''}' (want 'send')`);
    }
    return parseSend(flags);
  }
  throw new Error(`expected 'message' or 'inbox' command, got '${cmd ?? ''}'`);
}

export interface MessageCommandOptions {
  /** The session env's `KARST_TICKET`; when set it must name the sender. */
  sessionTicketKey?: string | undefined;
}

const label = (t: Pick<Ticket, 'id' | 'key'>): string => t.key ?? `#${t.id}`;

/** Refuse a `--ticket` that disagrees with the session env's own ticket. */
function assertSenderMatchesSession(sender: Ticket, sessionKey: string | undefined): void {
  if (sessionKey === undefined || sessionKey === '') return;
  if (sessionKey !== sender.key) {
    throw new Error(
      `--ticket resolves to '${label(sender)}' but this session's KARST_TICKET is '${sessionKey}' — ` +
        `refusing: a session may act only as its own ticket`,
    );
  }
}

/** Resolve `--to`: the literal `parent`, else a key (project-scoped, a child first). */
function resolveRecipient(store: Store, sender: Ticket, to: string): Ticket {
  if (to === 'parent') {
    if (sender.subtaskParentId === null) {
      throw new Error(`ticket '${label(sender)}' has no parent to message`);
    }
    const parent = findTicketById(store, sender.subtaskParentId);
    if (!parent) throw new Error(`the parent of '${label(sender)}' no longer exists`);
    return parent;
  }
  const matches = getTicketsByKey(
    store,
    to,
    sender.projectId === null ? {} : { projectId: sender.projectId },
  );
  // A key two live rows share is resolved toward OUR child; anything else falls
  // through to the rule, which refuses it with a reason.
  const hit = matches.find((t) => t.subtaskParentId === sender.id) ?? matches[0];
  // Unknown and other-project keys get the SAME generic answer, before the
  // rule runs: a sender learns nothing about tickets outside its project.
  if (!hit || hit.projectId !== sender.projectId) {
    throw new Error(`no ticket found for '${sanitizeInline(to)}'`);
  }
  return hit;
}

function runSend(store: Store, sender: Ticket, to: string, body: string): string {
  const recipient = resolveRecipient(store, sender, to);
  const verdict = checkMessaging(sender, recipient);
  if (!verdict.ok) throw new Error(`cannot message '${label(recipient)}': ${verdict.reason}`);
  const posted = postMessage(store, {
    projectId: sender.projectId,
    fromTicketId: sender.id,
    toTicketId: recipient.id,
    kind: 'message',
    body,
  });
  return JSON.stringify({
    ok: true,
    id: posted.id,
    to: label(recipient),
    kind: posted.kind,
  });
}

/** Header for one printed row. Agent senders are always labelled untrusted. */
function frame(me: Ticket, m: TicketMessage, from: Ticket | undefined): string {
  if (m.fromTicketId === null) return 'karst event:';
  // Keys are stored text too: strip controls so a key cannot forge a header.
  const key = sanitizeInline(from ? label(from) : `#${m.fromTicketId}`);
  if (from && from.subtaskParentId === me.id) return `from sub-task agent ${key} (untrusted):`;
  if (me.subtaskParentId === m.fromTicketId) return `from parent agent ${key} (untrusted):`;
  return `from ticket agent ${key} (untrusted):`;
}

/** Most rows printed per `inbox` call; the rest stay unread for the next. */
export const INBOX_PAGE = 20;

function runInbox(store: Store, me: Ticket, all: boolean, json: boolean): string {
  const listed = listInbox(store, me.id, { unreadOnly: !all });
  const rows = listed.slice(0, INBOX_PAGE);
  const moreUnread = listed.slice(INBOX_PAGE).filter((m) => m.readAt === null).length;
  const senders = new Map<number, Ticket | undefined>();
  for (const m of rows) {
    if (m.fromTicketId !== null && !senders.has(m.fromTicketId)) {
      senders.set(m.fromTicketId, findTicketById(store, m.fromTicketId));
    }
  }
  // Only what was printed is marked: a row that lands after the listing stays
  // unread for the next call instead of being swallowed unseen.
  markRead(
    store,
    rows.filter((m) => m.readAt === null).map((m) => m.id),
  );

  if (json) {
    return JSON.stringify({
      ok: true,
      messages: rows.map((m) => ({
        id: m.id,
        kind: m.kind,
        from: m.fromTicketId === null ? null : label(senders.get(m.fromTicketId) ?? { id: m.fromTicketId, key: null }),
        body: m.body,
        createdAt: m.createdAt,
        wasRead: m.readAt !== null,
      })),
      moreUnread,
    });
  }
  if (rows.length === 0) return all ? 'No messages.' : 'No unread messages.';
  const printed = rows
    .map((m) => `${frame(me, m, senders.get(m.fromTicketId ?? -1))}\n${quoteUntrusted(m.body)}`)
    .join('\n\n');
  return moreUnread > 0 ? `${printed}\n\n${moreUnread} more unread — run inbox again` : printed;
}

/**
 * Run `message send` / `inbox` as `sender`. `sessionTicketKey` is the session
 * env's `KARST_TICKET`, read by the caller (never here) so tests inject it and
 * `parseGlobalFlags` stays untouched.
 */
export function runMessageCommand(
  store: Store,
  sender: Ticket,
  argv: string[],
  options: MessageCommandOptions,
  debug?: (message: string) => void,
): string {
  const parsed = parseMessageArgs(argv);
  // `send` speaks AS a ticket, so it needs the session's attestation; `inbox`
  // only reads, and keeps the env optional (a human may run it by hand).
  if (parsed.verb === 'send' && !options.sessionTicketKey) {
    throw new Error(
      'message send needs KARST_TICKET (the karst session env) — run it from the ticket\'s karst session terminal',
    );
  }
  assertSenderMatchesSession(sender, options.sessionTicketKey);
  debug?.(`[cli] ${parsed.verb} as ${label(sender)}`);
  return parsed.verb === 'send'
    ? runSend(store, sender, parsed.to, parsed.body)
    : runInbox(store, sender, parsed.all, parsed.json);
}
