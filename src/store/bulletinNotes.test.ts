import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openStore, type Store } from './db.js';
import { createTicket } from './tickets.js';
import { upsertProject } from './projects.js';
import { openImplementationRun } from './implementationRuns.js';
import {
  BULLETIN_BODY_MAX,
  BULLETIN_TITLE_MAX,
  hostOverlaps,
  listNotes,
  markNotesRead,
  normalizeRepoPaths,
  postAgentNote,
  pushableNotes,
  recordTicketMerged,
  ticketNoteScope,
  unreadNotesByTicket,
  type BulletinNote,
  type NoteCandidate,
} from './bulletinNotes.js';

function seedWorktree(store: Store, ticketId: number, repo: string): void {
  store.db
    .prepare('INSERT INTO worktrees (ticket_id, repo, path, branch, base_ref) VALUES (?, ?, ?, ?, ?)')
    .run(ticketId, repo, `/wt/${repo}`, `karst/${repo}`, 'main');
}

describe('bulletinNotes', () => {
  let store: Store;
  let projectId: number;
  beforeEach(() => {
    store = openStore(':memory:');
    projectId = upsertProject(store, { slug: 'p1' }).id;
  });
  afterEach(() => store.close());

  describe('normalizeRepoPaths', () => {
    it('strips leading ./ and /, normalizes backslashes, dedupes and sorts', () => {
      expect(normalizeRepoPaths(['./src/a.ts', '/src/b.ts', 'src\\a.ts', 'src/a.ts'])).toEqual([
        'src/a.ts',
        'src/b.ts',
      ]);
    });

    it('drops any path with a .. segment', () => {
      expect(normalizeRepoPaths(['../outside', 'src/../../etc', 'src/ok.ts'])).toEqual(['src/ok.ts']);
    });
  });

  describe('postAgentNote', () => {
    it('writes an agent note with repos from the ticket worktrees and NULL paths', () => {
      const a = createTicket(store, { key: 'A', title: 'a', projectId });
      seedWorktree(store, a.id, 'api');
      seedWorktree(store, a.id, 'web');

      const note = postAgentNote(store, {
        projectId,
        fromTicketId: a.id,
        title: 'Watch the schema bump',
        body: 'The ABI copy step is easy to miss.',
      });

      expect(note.source).toBe('agent');
      expect(note.mergeSha).toBeNull();
      expect(note.repos).toEqual(['api', 'web']);
      expect(note.paths).toBeNull();
    });

    it('refuses an over-long title, an over-long body, and control characters', () => {
      const a = createTicket(store, { key: 'A', title: 'a' });
      const post = (title: string, body: string) =>
        postAgentNote(store, { projectId: null, fromTicketId: a.id, title, body });

      expect(() => post('x'.repeat(BULLETIN_TITLE_MAX + 1), 'ok')).toThrow(/limit is 120/);
      expect(() => post('multi\nline', 'ok')).toThrow(/single line/);
      expect(() => post('ok', 'x'.repeat(BULLETIN_BODY_MAX + 1))).toThrow(/limit is 4096/);
      expect(() => post('ok', 'bad\u0007bell')).toThrow(/control character/);
      expect(() => post('ok', '')).toThrow(/empty/);
    });
  });

  describe('recordTicketMerged', () => {
    it('writes one host note from the merge facts, idempotently', () => {
      const a = createTicket(store, { key: 'A', title: 'a', projectId });
      recordTicketMerged(store, {
        ticketId: a.id,
        repo: 'api',
        mergeSha: 'sha1',
        changedPaths: ['src/store/prs.ts', 'src/cli/main.ts'],
      });
      // A re-probe of the same merge writes no second note.
      recordTicketMerged(store, {
        ticketId: a.id,
        repo: 'api',
        mergeSha: 'sha1',
        changedPaths: ['src/store/prs.ts', 'src/cli/main.ts'],
      });

      const notes = listNotes(store, {
        readerTicketId: 999,
        projectId,
        scope: { repos: ['api'], paths: null },
        all: true,
      });
      const hosts = notes.filter((n) => n.source === 'host');
      expect(hosts).toHaveLength(1);
      expect(hosts[0]!.title).toContain('A');
      expect(hosts[0]!.title).toContain('api');
      expect(hosts[0]!.mergeSha).toBe('sha1');
      expect(hosts[0]!.repos).toEqual(['api']);
      expect(hosts[0]!.paths).toEqual(['src/cli/main.ts', 'src/store/prs.ts']);
      expect(hosts[0]!.body).toContain('src/store/prs.ts');
    });

    it('stamps the ticket agent notes with the repo and normalized paths', () => {
      const a = createTicket(store, { key: 'A', title: 'a', projectId });
      seedWorktree(store, a.id, 'api');
      const agent = postAgentNote(store, {
        projectId,
        fromTicketId: a.id,
        title: 'learning',
        body: 'prose',
      });
      expect(agent.paths).toBeNull();

      recordTicketMerged(store, {
        ticketId: a.id,
        repo: 'api',
        mergeSha: 'sha1',
        changedPaths: ['./src/store/prs.ts', '../escape.ts'],
      });

      const stored = store.db
        .prepare('SELECT repos, paths FROM bulletin_notes WHERE id = ?')
        .get(agent.id) as { repos: string; paths: string };
      expect(JSON.parse(stored.repos)).toEqual(['api']);
      // '../escape.ts' is dropped; the other is normalized.
      expect(JSON.parse(stored.paths)).toEqual(['src/store/prs.ts']);
    });

    it('writes a host note with NULL paths when the changed-path list was incomplete', () => {
      const a = createTicket(store, { key: 'A', title: 'a' });
      recordTicketMerged(store, { ticketId: a.id, repo: 'api', mergeSha: 'sha1', changedPaths: null });
      const row = store.db
        .prepare("SELECT paths FROM bulletin_notes WHERE source = 'host'")
        .get() as { paths: string | null };
      expect(row.paths).toBeNull();
    });
  });

  describe('listNotes', () => {
    function reader() {
      const r = createTicket(store, { key: 'READER', title: 'reader', projectId });
      seedWorktree(store, r.id, 'api');
      return r;
    }

    it('offers relevant notes, excludes the reader own notes, and marks reads', () => {
      const me = reader();
      const other = createTicket(store, { key: 'OTHER', title: 'other', projectId });
      seedWorktree(store, other.id, 'api');
      postAgentNote(store, { projectId, fromTicketId: other.id, title: 'relevant', body: 'hi' });
      // My own note must never be offered back to me.
      postAgentNote(store, { projectId, fromTicketId: me.id, title: 'mine', body: 'hi' });
      // A note in another repo is irrelevant.
      const far = createTicket(store, { key: 'FAR', title: 'far', projectId });
      seedWorktree(store, far.id, 'web');
      postAgentNote(store, { projectId, fromTicketId: far.id, title: 'far', body: 'hi' });

      const scope = ticketNoteScope(store, me.id);
      const first = listNotes(store, { readerTicketId: me.id, projectId, scope, all: false });
      expect(first.map((n) => n.title)).toEqual(['relevant']);
      expect(first[0]!.wasRead).toBe(false);

      markNotesRead(store, me.id, first.map((n) => n.id));
      expect(listNotes(store, { readerTicketId: me.id, projectId, scope, all: false })).toEqual([]);
      expect(
        listNotes(store, { readerTicketId: me.id, projectId, scope, all: true })[0]!.wasRead,
      ).toBe(true);
    });

    it('scopes to the reader project', () => {
      const me = reader();
      const otherProject = upsertProject(store, { slug: 'p2' }).id;
      const other = createTicket(store, { key: 'OTHER', title: 'other', projectId: otherProject });
      seedWorktree(store, other.id, 'api');
      postAgentNote(store, { projectId: otherProject, fromTicketId: other.id, title: 'other-project', body: 'hi' });

      const scope = ticketNoteScope(store, me.id);
      expect(listNotes(store, { readerTicketId: me.id, projectId, scope, all: true })).toEqual([]);
    });

    it('uses the reader own merged paths for prefix matching', () => {
      const me = reader();
      // The reader's own host note (from a previous merge) gives it paths.
      recordTicketMerged(store, {
        ticketId: me.id,
        repo: 'api',
        mergeSha: 'me-sha',
        changedPaths: ['src/store/prs.ts'],
      });
      const other = createTicket(store, { key: 'OTHER', title: 'other', projectId });
      seedWorktree(store, other.id, 'api');
      postAgentNote(store, { projectId, fromTicketId: other.id, title: 'adjacent', body: 'hi' });
      // Stamp the other note with a path that overlaps the reader's.
      recordTicketMerged(store, {
        ticketId: other.id,
        repo: 'api',
        mergeSha: 'other-sha',
        changedPaths: ['src/store/prs.ts'],
      });

      const scope = ticketNoteScope(store, me.id);
      expect(scope.paths).toEqual(['src/store/prs.ts']);
      const notes = listNotes(store, { readerTicketId: me.id, projectId, scope, all: true });
      expect(notes.some((n) => n.title === 'adjacent')).toBe(true);
    });
  });
});

describe('pushableNotes', () => {
  const note = (over: Partial<{ source: 'host' | 'agent'; paths: string[] | null }> = {}): BulletinNote => ({
    id: 1,
    projectId: 1,
    source: over.source ?? 'agent',
    fromTicketId: 2,
    mergeSha: over.source === 'host' ? 'sha' : null,
    title: 't',
    body: 'b',
    repos: ['api'],
    paths: over.paths ?? null,
    createdAt: '2026-01-01 00:00:00',
  });

  const candidate = (n: BulletinNote, over: Partial<NoteCandidate> = {}): NoteCandidate => ({
    note: n,
    wasShown: false,
    wasRead: false,
    ...over,
  });

  it('lists an agent note that matches the reader repo', () => {
    expect(pushableNotes([candidate(note())], { repos: ['api'], paths: null })).toHaveLength(1);
  });

  it('drops a note already shown or read', () => {
    const scope = { repos: ['api'], paths: null };
    expect(pushableNotes([candidate(note(), { wasShown: true })], scope)).toEqual([]);
    expect(pushableNotes([candidate(note(), { wasRead: true })], scope)).toEqual([]);
  });

  it('lists a host merge only when its paths overlap a known reader path set', () => {
    const host = note({ source: 'host', paths: ['src/store/prs.ts'] });
    expect(pushableNotes([candidate(host)], { repos: ['api'], paths: ['src/store/prs.ts'] })).toHaveLength(1);
    // Reader paths unknown → no host push.
    expect(pushableNotes([candidate(host)], { repos: ['api'], paths: null })).toEqual([]);
    // Known but non-overlapping → no host push.
    expect(pushableNotes([candidate(host)], { repos: ['api'], paths: ['src/ui/x.ts'] })).toEqual([]);
  });

  it('hostOverlaps mirrors the listed rule', () => {
    expect(hostOverlaps(note({ source: 'host', paths: ['a/b.ts'] }), { repos: ['api'], paths: ['a/b.ts'] })).toBe(true);
    expect(hostOverlaps(note({ source: 'host', paths: null }), { repos: ['api'], paths: ['a/b.ts'] })).toBe(false);
    expect(hostOverlaps(note({ source: 'agent', paths: ['a/b.ts'] }), { repos: ['api'], paths: ['a/b.ts'] })).toBe(false);
  });
});

describe('unreadNotesByTicket (push relevance + session-start cutoff)', () => {
  let store: Store;
  let projectId: number;
  let reader: number;
  let seq = 0;

  const BEFORE = '2026-01-01 00:00:00';
  const AFTER = '2026-01-02 00:00:00';

  beforeEach(() => {
    store = openStore(':memory:');
    projectId = upsertProject(store, { slug: 'p1' }).id;
    reader = createTicket(store, { key: 'R', title: 'r', projectId }).id;
    seedWorktree(store, reader, 'api');
  });
  afterEach(() => store.close());

  function other(repo = 'api'): number {
    seq++;
    const t = createTicket(store, { key: `O${seq}`, title: 'o', projectId }).id;
    seedWorktree(store, t, repo);
    return t;
  }

  function setCreated(id: number, at: string): void {
    store.db.prepare('UPDATE bulletin_notes SET created_at = ? WHERE id = ?').run(at, id);
  }

  function confirm(ticketId: number, at: string): void {
    seq++;
    store.db
      .prepare(
        `INSERT INTO session_launch_intents
           (ticket_id, launch_id, purpose, provider, reason, session_origin, status, created_at)
         VALUES (?, ?, 'implementation', 'claude', 'initial', 'new', 'confirmed', ?)`,
      )
      .run(ticketId, `L-${seq}`, at);
  }

  function row(ticketId: number): { toTicketId: number; unread: number; maxId: number } | undefined {
    return unreadNotesByTicket(store, projectId).find((r) => r.toTicketId === ticketId);
  }

  function hostMerges(poster: number, count: number, paths: string[], at: string): number {
    for (let i = 0; i < count; i++) {
      recordTicketMerged(store, { ticketId: poster, repo: 'api', mergeSha: `sha-${seq}-${i}`, changedPaths: paths });
    }
    let max = 0;
    const rows = store.db
      .prepare("SELECT id FROM bulletin_notes WHERE source = 'host' AND from_ticket_id = ?")
      .all(poster) as Array<{ id: number }>;
    for (const r of rows) {
      setCreated(r.id, at);
      if (r.id > max) max = r.id;
    }
    return max;
  }

  it('169 host merges created BEFORE the session start push nothing to a reader with no paths', () => {
    const poster = other();
    hostMerges(poster, 169, ['src/ui/x.ts'], BEFORE);
    confirm(reader, AFTER);
    expect(row(reader)).toBeUndefined();
  });

  it('169 host merges created after the start but non-overlapping still collapse (no push)', () => {
    store.db
      .prepare('UPDATE tickets SET code_pointers = ? WHERE id = ?')
      .run('- src/context/ticketContext.ts — context', reader);
    const poster = other();
    hostMerges(poster, 169, ['src/ui/x.ts'], AFTER);
    confirm(reader, BEFORE);
    expect(row(reader)).toBeUndefined();
  });

  it('one agent note in the same repo after the start is pushed', () => {
    const poster = other();
    const note = postAgentNote(store, { projectId, fromTicketId: poster, title: 'new learning', body: 'b' });
    setCreated(note.id, AFTER);
    confirm(reader, BEFORE);
    expect(row(reader)).toEqual({ toTicketId: reader, unread: 1, maxId: note.id });
  });

  it('a host merge that overlaps the reader paths after the start is counted', () => {
    store.db
      .prepare('UPDATE tickets SET code_pointers = ? WHERE id = ?')
      .run('- src/store/prs.ts — pr store', reader);
    const poster = other();
    const max = hostMerges(poster, 1, ['src/store/prs.ts'], AFTER);
    confirm(reader, BEFORE);
    expect(row(reader)).toEqual({ toTicketId: reader, unread: 1, maxId: max });
  });

  it('a note already shown in context or already read is not pushed', () => {
    const poster = other();
    const shown = postAgentNote(store, { projectId, fromTicketId: poster, title: 'shown', body: 'b' });
    setCreated(shown.id, AFTER);
    store.db
      .prepare('INSERT INTO bulletin_context_shown (note_id, reader_ticket_id) VALUES (?, ?)')
      .run(shown.id, reader);
    expect(row(reader)).toBeUndefined();

    const read = postAgentNote(store, { projectId, fromTicketId: poster, title: 'read', body: 'b' });
    setCreated(read.id, AFTER);
    markNotesRead(store, reader, [read.id]);
    expect(row(reader)).toBeUndefined();
  });

  it('the cutoff prefers a confirmed launch intent over the implementation run', () => {
    const poster = other();
    const note = postAgentNote(store, { projectId, fromTicketId: poster, title: 'old', body: 'b' });
    setCreated(note.id, AFTER);
    // The run started before the note; the later confirmed launch excludes it.
    openImplementationRun(store, { ticketId: reader, attempt: 1, provider: 'claude', startedAt: BEFORE });
    confirm(reader, '2026-01-03 00:00:00');
    expect(row(reader)).toBeUndefined();
  });

  it('the cutoff falls back to the implementation run when no intent is confirmed', () => {
    const poster = other();
    const note = postAgentNote(store, { projectId, fromTicketId: poster, title: 'old', body: 'b' });
    setCreated(note.id, AFTER);
    openImplementationRun(store, { ticketId: reader, attempt: 1, provider: 'claude', startedAt: '2026-01-03 00:00:00' });
    expect(row(reader)).toBeUndefined();
    // A note after the run start is pushed.
    const fresh = postAgentNote(store, { projectId, fromTicketId: poster, title: 'fresh', body: 'b' });
    setCreated(fresh.id, '2026-01-04 00:00:00');
    expect(row(reader)?.unread).toBe(1);
  });

  it('the cutoff falls back to the ticket creation when there is no intent or run', () => {
    store.db.prepare('UPDATE tickets SET created_at = ? WHERE id = ?').run('2026-01-01 12:00:00', reader);
    const poster = other();
    const before = postAgentNote(store, { projectId, fromTicketId: poster, title: 'before', body: 'b' });
    setCreated(before.id, '2026-01-01 06:00:00');
    expect(row(reader)).toBeUndefined();
    const after = postAgentNote(store, { projectId, fromTicketId: poster, title: 'after', body: 'b' });
    setCreated(after.id, '2026-01-01 18:00:00');
    expect(row(reader)?.unread).toBe(1);
  });

  it('never pushes a note authored by the reader itself', () => {
    const mine = postAgentNote(store, { projectId, fromTicketId: reader, title: 'mine', body: 'b' });
    setCreated(mine.id, AFTER);
    expect(row(reader)).toBeUndefined();
  });

  it('reads the whole backlog when nothing but the ticket creation exists (sanity)', () => {
    store.db.prepare('UPDATE tickets SET created_at = ? WHERE id = ?').run('2025-01-01 00:00:00', reader);
    const poster = other();
    const note = postAgentNote(store, { projectId, fromTicketId: poster, title: 'any', body: 'b' });
    setCreated(note.id, AFTER);
    expect(row(reader)?.unread).toBe(1);
  });

  it('omits tickets that are archived or in done stage even when they have worktrees', () => {
    const poster = other();
    const note = postAgentNote(store, { projectId, fromTicketId: poster, title: 'agent note', body: 'b' });
    setCreated(note.id, AFTER);
    confirm(reader, BEFORE);

    // Verify reader normally receives the note
    expect(row(reader)?.unread).toBe(1);

    // When ticket is archived, it must not be included
    store.db.prepare("UPDATE tickets SET archived_at = datetime('now') WHERE id = ?").run(reader);
    expect(row(reader)).toBeUndefined();

    // When unarchived, it is included again
    store.db.prepare('UPDATE tickets SET archived_at = NULL WHERE id = ?').run(reader);
    expect(row(reader)?.unread).toBe(1);

    // When stage_current is 'done', it must not be included
    store.db.prepare("UPDATE tickets SET stage_current = 'done' WHERE id = ?").run(reader);
    expect(row(reader)).toBeUndefined();
  });
});
