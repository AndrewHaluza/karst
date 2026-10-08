import type { Store } from '../store/db.js';
import { findTicketById, type Ticket } from '../store/tickets.js';
import { quoteUntrusted, sanitizeInline } from '../model/messageText.js';
import { assertSenderMatchesSession, ticketLabel } from './sessionIdentity.js';
import {
  listNotes,
  listNotesForRepos,
  markNotesRead,
  postAgentNote,
  ticketNoteScope,
  type BulletinNoteView,
} from '../store/bulletinNotes.js';

/**
 * The `karst notes` verbs — the project bulletin (v72). A SEPARATE parse path
 * from `stage`/`phase`/`subtask`, like `message`: it accepts only its own flags,
 * produces no `Verdict`, never imports the machine, and can never move a ticket.
 *
 * `notes` (default) lists the notes relevant to the caller's ticket, oldest
 * first, and marks the printed rows read (so `--all` lists already-read ones
 * too). `notes post --title <t> --body <b>` writes one UNTRUSTED learning: the
 * CLI ALWAYS writes `source='agent'` and can never forge a `source='host'` fact
 * (only the merge hook in `store/prs.ts` writes those).
 *
 * Sender identity is `--ticket` (argv), cross-checked by the caller against the
 * session env's `KARST_TICKET`: attested, not unforgeable (cli.md). Agent prose
 * is quoted line by line when printed, exactly like a mailbox body.
 */

export type ParsedNotesArgs =
  | { verb: 'list'; all: boolean; json: boolean }
  | { verb: 'post'; title: string; body: string }
  | { verb: 'repos'; repos: string[]; json: boolean };

function parsePost(rest: string[]): ParsedNotesArgs {
  let title: string | undefined;
  let body: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i];
    if (token === '--title') {
      title = rest[++i];
      if (title === undefined) throw new Error('karst notes post: --title needs a value');
    } else if (token === '--body') {
      body = rest[++i];
      if (body === undefined) throw new Error('karst notes post: --body needs a value');
    } else {
      throw new Error(`unknown flag '${token}' (want --title or --body)`);
    }
  }
  if (title === undefined) {
    throw new Error('missing --title (usage: notes post --title <t> --body <b>)');
  }
  if (body === undefined) {
    throw new Error('missing --body (usage: notes post --title <t> --body <b>)');
  }
  return { verb: 'post', title, body };
}

function parseList(rest: string[]): ParsedNotesArgs {
  let all = false;
  let json = false;
  for (const token of rest) {
    if (token === '--all') all = true;
    else if (token === '--json') json = true;
    else throw new Error(`unknown flag '${token}' (want --all or --json)`);
  }
  return { verb: 'list', all, json };
}

/**
 * `--repos a,b [--json]`: the planner's read of the notes for a stack. Only
 * names are accepted; the project comes from KARST_PROJECT, never from argv.
 */
function parseRepos(rest: string[]): ParsedNotesArgs {
  let repos: string[] | undefined;
  let json = false;
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i];
    if (token === '--repos') {
      const value = rest[++i];
      if (value === undefined) throw new Error('karst notes: --repos needs a value (a,b)');
      const names = value.split(',').map((n) => n.trim());
      if (names.some((n) => n === '')) {
        throw new Error('karst notes: --repos needs non-empty repository names (a,b)');
      }
      repos = [...new Set(names)];
    } else if (token === '--json') {
      json = true;
    } else {
      throw new Error(`unknown flag '${token}' (want --repos or --json)`);
    }
  }
  if (repos === undefined) throw new Error('karst notes: --repos needs a value (a,b)');
  return { verb: 'repos', repos, json };
}

/** Parse `['notes', ...flags]` or `['notes','post',..flags]`; names the bad token. */
export function parseNotesArgs(argv: string[]): ParsedNotesArgs {
  const [cmd, ...rest] = argv;
  if (cmd !== 'notes') {
    throw new Error(`expected 'notes' command, got '${cmd ?? ''}'`);
  }
  const [sub, ...flags] = rest;
  if (rest.includes('--repos')) {
    if (sub === 'post') throw new Error('karst notes: --repos cannot be combined with post');
    return parseRepos(rest);
  }
  if (sub === 'post') return parsePost(flags);
  if (sub === 'list') return parseList(flags);
  // No subcommand (or any leading flag) means the default `list` verb.
  return parseList(rest);
}

export interface NotesCommandOptions {
  /** The session env's `KARST_TICKET`; required by both verbs and must name the caller. */
  sessionTicketKey?: string | undefined;
}

/** Header + quoted body for one printed note. Agent prose is always untrusted. */
function renderNote(note: Pick<BulletinNoteView, 'source' | 'title' | 'body'>, fromKey: string): string {
  const key = sanitizeInline(fromKey);
  const title = sanitizeInline(note.title);
  if (note.source === 'host') {
    return `karst fact: ${key} — ${title}:\n${note.body}`;
  }
  return `from ticket ${key} (untrusted) — ${title}:\n${quoteUntrusted(note.body)}`;
}

function runPost(store: Store, sender: Ticket, parsed: Extract<ParsedNotesArgs, { verb: 'post' }>): string {
  const note = postAgentNote(store, {
    projectId: sender.projectId,
    fromTicketId: sender.id,
    title: parsed.title,
    body: parsed.body,
  });
  return JSON.stringify({ ok: true, id: note.id, source: 'agent' });
}

/** A note as printed; `wasRead` is absent in repos mode (nothing is marked). */
type PrintedNote = Omit<BulletinNoteView, 'wasRead'> & { wasRead?: boolean };

/** The display key of each note's author ticket, resolved once per ticket. */
function fromKeys(store: Store, notes: readonly PrintedNote[]): Map<number, string> {
  const keys = new Map<number, string>();
  for (const n of notes) {
    if (!keys.has(n.fromTicketId)) {
      const from = findTicketById(store, n.fromTicketId);
      keys.set(n.fromTicketId, from ? ticketLabel(from) : `#${n.fromTicketId}`);
    }
  }
  return keys;
}

/** The shared output of list and repos modes: JSON envelope or framed notes. */
function renderNoteList(
  notes: readonly PrintedNote[],
  keys: Map<number, string>,
  json: boolean,
  emptyText: string,
): string {
  if (json) {
    return JSON.stringify({
      ok: true,
      notes: notes.map((n) => ({
        id: n.id,
        source: n.source,
        from: keys.get(n.fromTicketId),
        mergeSha: n.mergeSha,
        title: n.title,
        body: n.body,
        repos: n.repos,
        paths: n.paths,
        createdAt: n.createdAt,
        wasRead: n.wasRead,
      })),
    });
  }
  if (notes.length === 0) return emptyText;
  return notes.map((n) => renderNote(n, keys.get(n.fromTicketId)!)).join('\n\n');
}

function runList(store: Store, me: Ticket, parsed: Extract<ParsedNotesArgs, { verb: 'list' }>): string {
  const scope = ticketNoteScope(store, me.id);
  const notes = listNotes(store, {
    readerTicketId: me.id,
    projectId: me.projectId,
    scope,
    all: parsed.all,
  });
  // Only what was printed is marked: a note landing after the listing stays
  // unread for the next call.
  markNotesRead(store, me.id, notes.map((n) => n.id));
  return renderNoteList(
    notes,
    fromKeys(store, notes),
    parsed.json,
    parsed.all ? 'No notes.' : 'No unread notes.',
  );
}

/** A KARST_PROJECT value: a positive integer, or undefined when it is not one. */
function parseProjectEnv(raw: string | undefined): number | undefined {
  if (raw === undefined || !/^[1-9]\d*$/.test(raw)) return undefined;
  return Number(raw);
}

/**
 * `notes --repos a,b` as a planning session: READ-ONLY. It marks nothing read,
 * posts nothing and needs no ticket. The project id is the host-set
 * KARST_PROJECT (`projectEnv`), never inferred from cwd or the manifest.
 */
export function runNotesReposCommand(
  store: Store,
  projectEnv: string | undefined,
  argv: string[],
): string {
  const parsed = parseNotesArgs(argv);
  if (parsed.verb !== 'repos') throw new Error('notes --repos: expected a --repos argument');
  const projectId = parseProjectEnv(projectEnv);
  if (projectId === undefined) {
    throw new Error(
      'notes --repos needs KARST_PROJECT (the host-set project id, a positive integer) — run it from a karst planning session',
    );
  }
  const notes = listNotesForRepos(store, projectId, parsed.repos);
  return renderNoteList(notes, fromKeys(store, notes), parsed.json, 'No notes for these repos.');
}

/**
 * Run `notes` / `notes post` as the caller. `sessionTicketKey` is the session
 * env's `KARST_TICKET`, read by the caller (never here) so tests inject it.
 */
export function runNotesCommand(
  store: Store,
  sender: Ticket,
  argv: string[],
  options: NotesCommandOptions,
  debug?: (message: string) => void,
): string {
  const parsed = parseNotesArgs(argv);
  if (parsed.verb === 'repos') {
    throw new Error('notes --repos reads without a ticket: it is run by runNotesReposCommand');
  }
  // Both verbs act AS the caller's ticket (`post` writes as it, `list` reads for
  // it and marks rows read), so both need the session's attestation.
  if (!options.sessionTicketKey) {
    throw new Error(
      `notes ${parsed.verb} needs KARST_TICKET (the karst session env) — run it from the ticket's karst session terminal`,
    );
  }
  assertSenderMatchesSession(sender, options.sessionTicketKey);
  debug?.(`[cli] notes ${parsed.verb} as ${ticketLabel(sender)}`);
  return parsed.verb === 'post'
    ? runPost(store, sender, parsed)
    : runList(store, sender, parsed);
}
