import type { Store } from './db.js';
import { forbiddenBodyChar, sanitizeInline } from '../model/messageText.js';
import { noteMatchesScope, type NoteScope } from '../model/bulletinRelevance.js';

/**
 * The project bulletin (v72): a pull-only, project-scoped board of notes a
 * ticket may learn from. Store-only — the same functions serve the extension's
 * better-sqlite3 store and the CLI's node:sqlite shim, and NOTHING here runs
 * git or gh.
 *
 * Two sources, distinguished by the trust of their prose:
 *  - `'host'` — a TRUSTED fact `recordTicketMerged` writes at the first
 *    merged-with-sha probe: the ticket key, the repo, the merged diff's paths.
 *  - `'agent'` — an UNTRUSTED learning the implementer posted before its done
 *    marker (`karst notes post`). Its repos are stamped from the ticket's
 *    worktrees at post time; its paths are stamped at merge from the diff.
 *
 * `repos`/`paths` are JSON string arrays; NULL means "never stamped".
 */

/** The DDL schema.sql mirrors for a fresh DB (the v72 migration step execs it). */
export const BULLETIN_DDL = `
CREATE TABLE IF NOT EXISTS bulletin_notes (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id     INTEGER REFERENCES projects(id) ON DELETE CASCADE,
  source         TEXT NOT NULL CHECK (source IN ('host', 'agent')),
  from_ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  merge_sha      TEXT,
  title          TEXT NOT NULL,
  body           TEXT NOT NULL,
  repos          TEXT,
  paths          TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (source <> 'host' OR merge_sha IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_bulletin_notes_source_ticket_sha
  ON bulletin_notes(source, from_ticket_id, merge_sha);
CREATE INDEX IF NOT EXISTS idx_bulletin_notes_ticket ON bulletin_notes(from_ticket_id, id);
CREATE TABLE IF NOT EXISTS bulletin_reads (
  note_id          INTEGER NOT NULL REFERENCES bulletin_notes(id) ON DELETE CASCADE,
  reader_ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  read_at          TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (note_id, reader_ticket_id)
);
`;

/** Title cap (one short line). */
export const BULLETIN_TITLE_MAX = 120;
/** Body cap, matching the mailbox body cap. */
export const BULLETIN_BODY_MAX = 4096;

export type BulletinSource = 'host' | 'agent';

export interface BulletinNote {
  id: number;
  projectId: number | null;
  source: BulletinSource;
  fromTicketId: number;
  /** The merged sha for a host row; NULL for every agent row. */
  mergeSha: string | null;
  title: string;
  body: string;
  /** Repo names the note is about; empty when never stamped. */
  repos: string[];
  /** Repo-relative changed paths; null when never stamped. */
  paths: string[] | null;
  createdAt: string;
}

interface NoteRow {
  id: number;
  project_id: number | null;
  source: string;
  from_ticket_id: number;
  merge_sha: string | null;
  title: string;
  body: string;
  repos: string | null;
  paths: string | null;
  created_at: string;
}

/** Parse a JSON string-array column, tolerating anything malformed as absent. */
function parseStringArray(raw: string | null): string[] | null {
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return parsed.filter((v): v is string => typeof v === 'string');
  } catch {
    return null;
  }
}

function rowToNote(r: NoteRow): BulletinNote {
  if (r.source !== 'host' && r.source !== 'agent') {
    throw new Error(`bulletin_notes row ${r.id} has unknown source '${r.source}'`);
  }
  return {
    id: r.id,
    projectId: r.project_id,
    source: r.source,
    fromTicketId: r.from_ticket_id,
    mergeSha: r.merge_sha,
    title: r.title,
    body: r.body,
    repos: parseStringArray(r.repos) ?? [],
    paths: parseStringArray(r.paths),
    createdAt: r.created_at,
  };
}

/**
 * Normalize repo-relative paths from a merged diff: forward slashes, no leading
 * `./` or `/`, no `.`/`..` segments, deduped and sorted. A path with a `..`
 * segment is dropped entirely — a merged diff never carries one, and trusting it
 * would let a path escape its repo.
 */
export function normalizeRepoPaths(paths: readonly string[]): string[] {
  const out = new Set<string>();
  for (const raw of paths) {
    if (typeof raw !== 'string') continue;
    const segments = raw.trim().replace(/\\/gu, '/').split('/');
    if (segments.some((s) => s === '..')) continue;
    const clean = segments.filter((s) => s !== '' && s !== '.').join('/');
    if (clean !== '') out.add(clean);
  }
  return [...out].sort();
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max);
}

/** Validate a title: one short line, no control characters. */
function normalizeTitle(title: string): string {
  const trimmed = title.trim();
  if (trimmed === '') throw new Error('note title is empty');
  if (trimmed.includes('\n') || trimmed.includes('\r')) {
    throw new Error('note title must be a single line');
  }
  const bad = forbiddenBodyChar(trimmed);
  if (bad !== null) {
    throw new Error(
      `note title contains control character ${bad}; only plain text is allowed`,
    );
  }
  if (trimmed.length > BULLETIN_TITLE_MAX) {
    throw new Error(`note title is ${trimmed.length} chars; the limit is ${BULLETIN_TITLE_MAX}`);
  }
  return trimmed;
}

/** Validate a body: plain multi-line text, no control characters. */
function normalizeNoteBody(body: string): string {
  const trimmed = body.trim();
  if (trimmed === '') throw new Error('note body is empty');
  const bad = forbiddenBodyChar(trimmed);
  if (bad !== null) {
    throw new Error(
      `note body contains control character ${bad}; only plain text with newlines and tabs is allowed`,
    );
  }
  if (trimmed.length > BULLETIN_BODY_MAX) {
    throw new Error(`note body is ${trimmed.length} chars; the limit is ${BULLETIN_BODY_MAX}`);
  }
  return trimmed;
}

export interface PostAgentNoteInput {
  projectId: number | null;
  fromTicketId: number;
  title: string;
  body: string;
}

/** The ticket's repos, from its worktrees (the scope it was cut in). */
function ticketRepos(store: Store, ticketId: number): string[] {
  const rows = store.db
    .prepare('SELECT DISTINCT repo FROM worktrees WHERE ticket_id = ? ORDER BY repo')
    .all(ticketId) as Array<{ repo: string }>;
  return rows.map((r) => r.repo);
}

/**
 * Post one UNTRUSTED agent learning. The agent supplies only title and prose;
 * repos come from the ticket's worktrees and paths stay NULL until
 * `recordTicketMerged` stamps the merged diff. The CLI is the only caller, and
 * it always passes its own `--ticket`, so `source` is always `'agent'`.
 */
export function postAgentNote(store: Store, input: PostAgentNoteInput): BulletinNote {
  const title = normalizeTitle(input.title);
  const body = normalizeNoteBody(input.body);
  const repos = ticketRepos(store, input.fromTicketId);
  const info = store.db
    .prepare(
      `INSERT INTO bulletin_notes (project_id, source, from_ticket_id, merge_sha, title, body, repos, paths)
       VALUES (?, 'agent', ?, NULL, ?, ?, ?, NULL)`,
    )
    .run(input.projectId, input.fromTicketId, title, body, JSON.stringify(repos));
  const id = Number(info.lastInsertRowid);
  const row = store.db.prepare('SELECT * FROM bulletin_notes WHERE id = ?').get(id) as
    | NoteRow
    | undefined;
  if (!row) throw new Error(`bulletin_notes row ${id} vanished after insert`);
  return rowToNote(row);
}

export interface RecordTicketMergedInput {
  ticketId: number;
  /** The repo whose PR just merged. */
  repo: string;
  mergeSha: string;
  /** The merged diff's paths, or null when the file list was incomplete. */
  changedPaths: readonly string[] | null;
}

/** The trusted host fact's body: the repo and the merged diff's paths. */
function hostNoteBody(repo: string, paths: readonly string[] | null): string {
  if (paths === null) {
    return `Merged in ${repo}. Changed paths unavailable (the file list was incomplete).`;
  }
  if (paths.length === 0) {
    return `Merged in ${repo}. No changed paths reported.`;
  }
  let body = `Merged in ${repo}. Changed paths:`;
  for (const p of paths) {
    const line = `\n- ${p}`;
    if (body.length + line.length > BULLETIN_BODY_MAX) {
      body += '\n- …';
      break;
    }
    body += line;
  }
  return body;
}

/**
 * Fire the merge hook. Called by `updatePrDetail` inside its transaction on the
 * FIRST probe that reports the PR merged AND a known sha.
 *
 * Writes ONE trusted host note (idempotent through the unique index, so a
 * re-probe of the same merge writes nothing) and stamps this ticket's agent
 * notes with the merged diff: their repos gain this repo and their paths gain
 * the normalized diff paths. A null `changedPaths` (incomplete file list) stamps
 * no paths, so relevance falls back to repo-only matching.
 */
export function recordTicketMerged(store: Store, input: RecordTicketMergedInput): void {
  const ticket = store.db
    .prepare('SELECT key, project_id FROM tickets WHERE id = ?')
    .get(input.ticketId) as { key: string | null; project_id: number | null } | undefined;
  const key = ticket?.key ?? `#${input.ticketId}`;
  const paths = input.changedPaths === null ? null : normalizeRepoPaths(input.changedPaths);
  const title = truncate(`${key} merged ${input.repo}`, BULLETIN_TITLE_MAX);
  store.db
    .prepare(
      `INSERT OR IGNORE INTO bulletin_notes (project_id, source, from_ticket_id, merge_sha, title, body, repos, paths)
       VALUES (?, 'host', ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      ticket?.project_id ?? null,
      input.ticketId,
      input.mergeSha,
      title,
      hostNoteBody(input.repo, paths),
      JSON.stringify([input.repo]),
      paths === null ? null : JSON.stringify(paths),
    );

  const agentNotes = store.db
    .prepare(`SELECT id, repos, paths FROM bulletin_notes WHERE source = 'agent' AND from_ticket_id = ?`)
    .all(input.ticketId) as Array<{ id: number; repos: string | null; paths: string | null }>;
  for (const note of agentNotes) {
    const noteRepos = new Set(parseStringArray(note.repos) ?? []);
    noteRepos.add(input.repo);
    const notePaths = new Set(parseStringArray(note.paths) ?? []);
    if (paths !== null) for (const p of paths) notePaths.add(p);
    store.db
      .prepare('UPDATE bulletin_notes SET repos = ?, paths = ? WHERE id = ?')
      .run(
        JSON.stringify([...noteRepos].sort()),
        notePaths.size === 0 ? null : JSON.stringify([...notePaths].sort()),
        note.id,
      );
  }
}

/** A note plus whether the reader has already seen it. */
export interface BulletinNoteView extends BulletinNote {
  wasRead: boolean;
}

/**
 * The reader's relevance scope: its worktrees' repos plus the paths its own
 * notes already carry (its merged diffs). Paths are null while it has none, so
 * relevance falls back to repo-only matching.
 */
export function ticketNoteScope(store: Store, ticketId: number): NoteScope {
  const repos = ticketRepos(store, ticketId);
  const rows = store.db
    .prepare('SELECT paths FROM bulletin_notes WHERE from_ticket_id = ? AND paths IS NOT NULL')
    .all(ticketId) as Array<{ paths: string }>;
  const paths = new Set<string>();
  for (const r of rows) for (const p of parseStringArray(r.paths) ?? []) paths.add(p);
  return { repos, paths: paths.size === 0 ? null : [...paths].sort() };
}

export interface ListNotesInput {
  readerTicketId: number;
  projectId: number | null;
  scope: NoteScope;
  /** Include notes this reader already saw (otherwise unread only). */
  all: boolean;
}

/**
 * The notes relevant to one reader, oldest first. Project-scoped (the DB is
 * shared by every window); the reader's OWN notes are excluded — the bulletin
 * is learnings for OTHER tasks. Relevance is the pure `noteMatchesScope`.
 */
export function listNotes(store: Store, input: ListNotesInput): BulletinNoteView[] {
  const scoped = input.projectId !== null;
  const readFilter = input.all
    ? ''
    : `AND NOT EXISTS (
         SELECT 1 FROM bulletin_reads br
          WHERE br.note_id = n.id AND br.reader_ticket_id = ?
       )`;
  const rows = store.db
    .prepare(
      `SELECT n.*,
              EXISTS (SELECT 1 FROM bulletin_reads br2
                       WHERE br2.note_id = n.id AND br2.reader_ticket_id = ?) AS was_read
         FROM bulletin_notes n
        WHERE n.from_ticket_id <> ?
          ${scoped ? 'AND n.project_id = ?' : ''}
          ${readFilter}
        ORDER BY n.id`,
    )
    .all(
      input.readerTicketId,
      input.readerTicketId,
      ...(scoped ? [input.projectId] : []),
      ...(input.all ? [] : [input.readerTicketId]),
    ) as Array<NoteRow & { was_read: number }>;
  return rows
    .map((r) => ({ ...rowToNote(r), wasRead: r.was_read !== 0 }))
    .filter((n) => noteMatchesScope(n, input.scope));
}

/** Mark notes read by a ticket; already-read rows are untouched. */
export function markNotesRead(store: Store, readerTicketId: number, noteIds: readonly number[]): number {
  let marked = 0;
  const stmt = store.db.prepare(
    `INSERT OR IGNORE INTO bulletin_reads (note_id, reader_ticket_id) VALUES (?, ?)`,
  );
  for (const id of noteIds) marked += Number(stmt.run(id, readerTicketId).changes);
  return marked;
}

/** At most this many titles reach a host-written index. */
export const NOTE_INDEX_TITLE_MAX = 10;

/** A host-written pointer to matching notes: counts and sanitized titles, never bodies. */
export interface NoteIndex {
  count: number;
  /** Newest-last, capped at `NOTE_INDEX_TITLE_MAX`, control characters stripped. */
  titles: string[];
}

function toIndex(notes: readonly BulletinNote[]): NoteIndex {
  return {
    count: notes.length,
    titles: notes.slice(-NOTE_INDEX_TITLE_MAX).map((n) => sanitizeInline(n.title)),
  };
}

/** The ticket's UNREAD matching notes as an index. Read-only: marks nothing. */
export function unreadNoteIndex(store: Store, ticketId: number): NoteIndex {
  const row = store.db.prepare('SELECT project_id FROM tickets WHERE id = ?').get(ticketId) as
    | { project_id: number | null }
    | undefined;
  const notes = listNotes(store, {
    readerTicketId: ticketId,
    projectId: row?.project_id ?? null,
    scope: ticketNoteScope(store, ticketId),
    all: false,
  });
  return toIndex(notes);
}

/** Per-ticket unread note count and newest unread note id, for the delivery sweep. */
export interface TicketNoteUnread {
  toTicketId: number;
  unread: number;
  maxId: number;
}

/** Unread matching notes for every ticket in the project that has worktrees. */
export function unreadNotesByTicket(store: Store, projectId: number): TicketNoteUnread[] {
  const tickets = store.db
    .prepare(
      `SELECT DISTINCT t.id AS id FROM tickets t JOIN worktrees w ON w.ticket_id = t.id
        WHERE t.project_id = ? ORDER BY t.id`,
    )
    .all(projectId) as Array<{ id: number }>;
  const out: TicketNoteUnread[] = [];
  for (const { id } of tickets) {
    const notes = listNotes(store, {
      readerTicketId: id,
      projectId,
      scope: ticketNoteScope(store, id),
      all: false,
    });
    if (notes.length > 0) {
      out.push({ toTicketId: id, unread: notes.length, maxId: Math.max(...notes.map((n) => n.id)) });
    }
  }
  return out;
}

/**
 * Notes for a planning stack: every project note whose repos intersect `repos`
 * (repo-only match — a planner has no paths). Pure read: no read tracking.
 */
export function listNotesForRepos(
  store: Store,
  projectId: number,
  repos: readonly string[],
): BulletinNote[] {
  const rows = store.db
    .prepare('SELECT * FROM bulletin_notes WHERE project_id = ? ORDER BY id')
    .all(projectId) as NoteRow[];
  return rows
    .map(rowToNote)
    .filter((n) => noteMatchesScope(n, { repos, paths: null }));
}

/** The planner's index over `listNotesForRepos`. */
export function repoNoteIndex(store: Store, projectId: number, repos: readonly string[]): NoteIndex {
  return toIndex(listNotesForRepos(store, projectId, repos));
}
