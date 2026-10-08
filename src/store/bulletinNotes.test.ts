import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openStore, type Store } from './db.js';
import { createTicket } from './tickets.js';
import { upsertProject } from './projects.js';
import {
  BULLETIN_BODY_MAX,
  BULLETIN_TITLE_MAX,
  listNotes,
  markNotesRead,
  normalizeRepoPaths,
  postAgentNote,
  recordTicketMerged,
  ticketNoteScope,
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
