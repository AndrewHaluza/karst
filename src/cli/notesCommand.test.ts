import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openStore, type Store } from '../store/db.js';
import { createTicket, findTicketById } from '../store/tickets.js';
import { upsertProject } from '../store/projects.js';
import { recordTicketMerged } from '../store/bulletinNotes.js';
import { parseNotesArgs, runNotesCommand, runNotesReposCommand } from './notesCommand.js';

function seedWorktree(store: Store, ticketId: number, repo: string): void {
  store.db
    .prepare('INSERT INTO worktrees (ticket_id, repo, path, branch, base_ref) VALUES (?, ?, ?, ?, ?)')
    .run(ticketId, repo, `/wt/${repo}`, `karst/${repo}`, 'main');
}

describe('parseNotesArgs', () => {
  it('parses list and post', () => {
    expect(parseNotesArgs(['notes'])).toEqual({ verb: 'list', all: false, json: false });
    expect(parseNotesArgs(['notes', '--all', '--json'])).toEqual({ verb: 'list', all: true, json: true });
    expect(parseNotesArgs(['notes', 'post', '--title', 'T', '--body', 'B'])).toEqual({
      verb: 'post',
      title: 'T',
      body: 'B',
    });
  });

  it('names the offending token', () => {
    expect(() => parseNotesArgs(['notes', 'post', '--title', 'T'])).toThrow(/--body/);
    expect(() => parseNotesArgs(['notes', 'post', '--body', 'B'])).toThrow(/--title/);
    expect(() => parseNotesArgs(['notes', 'post', '--title'])).toThrow(/--title needs a value/);
    expect(() => parseNotesArgs(['notes', 'post', '--title', 'T', '--body', 'B', '--nope'])).toThrow(
      /'--nope'/,
    );
    expect(() => parseNotesArgs(['notes', '--nope'])).toThrow(/'--nope'/);
    expect(() => parseNotesArgs(['notes', 'shout'])).toThrow(/'shout'/);
    expect(() => parseNotesArgs(['bogus'])).toThrow(/'bogus'/);
  });
});

describe('runNotesCommand', () => {
  let store: Store;
  let projectId: number;
  let meId: number;
  let otherId: number;

  beforeEach(() => {
    store = openStore(':memory:');
    projectId = upsertProject(store, { slug: 'p1' }).id;
    meId = createTicket(store, { key: 'K-1', title: 'me', projectId }).id;
    otherId = createTicket(store, { key: 'K-2', title: 'other', projectId }).id;
    seedWorktree(store, meId, 'api');
    seedWorktree(store, otherId, 'api');
  });
  afterEach(() => store.close());

  const sender = (id: number) => findTicketById(store, id)!;

  it('posts an agent note as the caller, never a host note', () => {
    const out = runNotesCommand(store, sender(meId), ['notes', 'post', '--title', 'T', '--body', 'B'], {
      sessionTicketKey: 'K-1',
    });
    expect(JSON.parse(out)).toMatchObject({ ok: true, source: 'agent' });
    const row = store.db
      .prepare('SELECT source, from_ticket_id, merge_sha FROM bulletin_notes')
      .get() as { source: string; from_ticket_id: number; merge_sha: string | null };
    expect(row).toEqual({ source: 'agent', from_ticket_id: meId, merge_sha: null });
  });

  it('refuses without KARST_TICKET and when it names a different ticket', () => {
    expect(() =>
      runNotesCommand(store, sender(meId), ['notes'], {}),
    ).toThrow(/needs KARST_TICKET/);
    expect(() =>
      runNotesCommand(store, sender(meId), ['notes'], { sessionTicketKey: 'K-2' }),
    ).toThrow(/act only as its own ticket/);
  });

  it('lists relevant notes, quotes agent prose as untrusted, and marks them read', () => {
    recordTicketMerged(store, {
      ticketId: otherId,
      repo: 'api',
      mergeSha: 'sha',
      changedPaths: ['src/store/prs.ts'],
    });
    runNotesCommand(store, sender(otherId), ['notes', 'post', '--title', 'tip', '--body', 'line one\nline two'], {
      sessionTicketKey: 'K-2',
    });

    const out = runNotesCommand(store, sender(meId), ['notes'], { sessionTicketKey: 'K-1' });
    expect(out).toContain('karst fact: K-2');
    expect(out).toContain('from ticket K-2 (untrusted)');
    expect(out).toContain('> line one');
    expect(out).toContain('> line two');

    // Printed rows are marked read: the next listing is empty, --all shows them.
    expect(runNotesCommand(store, sender(meId), ['notes'], { sessionTicketKey: 'K-1' })).toBe(
      'No unread notes.',
    );
    expect(
      runNotesCommand(store, sender(meId), ['notes', '--all', '--json'], { sessionTicketKey: 'K-1' }),
    ).toContain('"wasRead":true');
  });

  it('renders JSON with the source and from key', () => {
    recordTicketMerged(store, { ticketId: otherId, repo: 'api', mergeSha: 'sha', changedPaths: null });
    const parsed = JSON.parse(
      runNotesCommand(store, sender(meId), ['notes', '--json'], { sessionTicketKey: 'K-1' }),
    ) as { notes: Array<{ source: string; from: string; title: string }> };
    expect(parsed.notes).toHaveLength(1);
    expect(parsed.notes[0]).toMatchObject({ source: 'host', from: 'K-2' });
  });
});

describe('notes --repos (planner read)', () => {
  let store: Store;
  let projectId: number;
  let otherProjectId: number;

  beforeEach(() => {
    store = openStore(':memory:');
    projectId = upsertProject(store, { slug: 'p1' }).id;
    otherProjectId = upsertProject(store, { slug: 'p2' }).id;
    const authorId = createTicket(store, { key: 'K-1', title: 'author', projectId }).id;
    const otherAuthorId = createTicket(store, { key: 'K-9', title: 'elsewhere', projectId: otherProjectId }).id;
    seedWorktree(store, authorId, 'api');
    seedWorktree(store, authorId, 'web');
    seedWorktree(store, otherAuthorId, 'billing');
    runNotesCommand(store, findTicketById(store, authorId)!, ['notes', 'post', '--title', 'api tip', '--body', 'use the pool'], {
      sessionTicketKey: 'K-1',
    });
    runNotesCommand(store, findTicketById(store, otherAuthorId)!, ['notes', 'post', '--title', 'billing tip', '--body', 'x'], {
      sessionTicketKey: 'K-9',
    });
  });
  afterEach(() => store.close());

  it('parses --repos as a comma list with optional --json', () => {
    expect(parseNotesArgs(['notes', '--repos', 'api, web,api'])).toEqual({
      verb: 'repos',
      repos: ['api', 'web'],
      json: false,
    });
    expect(parseNotesArgs(['notes', '--repos', 'api', '--json'])).toMatchObject({ verb: 'repos', json: true });
  });

  it('refuses an empty --repos, a missing value, and --repos combined with post', () => {
    expect(() => parseNotesArgs(['notes', '--repos'])).toThrow(/--repos needs a value/);
    expect(() => parseNotesArgs(['notes', '--repos', 'api,,web'])).toThrow(/non-empty/);
    expect(() => parseNotesArgs(['notes', '--repos', ''])).toThrow(/non-empty/);
    expect(() =>
      parseNotesArgs(['notes', 'post', '--repos', 'api', '--title', 'T', '--body', 'B']),
    ).toThrow(/--repos cannot be combined with post/);
  });

  it('lists only notes for the named repos in the given project, without marking reads', () => {
    const out = runNotesReposCommand(store, String(projectId), ['notes', '--repos', 'api']);
    expect(out).toContain('api tip');
    expect(out).not.toContain('billing tip');
    expect(out).toContain('from ticket K-1 (untrusted)');
    const reads = store.db.prepare('SELECT COUNT(*) AS n FROM bulletin_reads').get() as { n: number };
    expect(reads.n).toBe(0);
    // Repeatable: nothing was marked, so the same note prints again.
    expect(runNotesReposCommand(store, String(projectId), ['notes', '--repos', 'api'])).toContain('api tip');
  });

  it('prints a JSON envelope with from keys', () => {
    const parsed = JSON.parse(runNotesReposCommand(store, String(projectId), ['notes', '--repos', 'web', '--json']));
    expect(parsed.notes).toHaveLength(1);
    expect(parsed.notes[0]).toMatchObject({ from: 'K-1', title: 'api tip' });
  });

  it('says so when nothing matches', () => {
    expect(runNotesReposCommand(store, String(projectId), ['notes', '--repos', 'nope'])).toBe(
      'No notes for these repos.',
    );
  });

  it('refuses a missing or invalid KARST_PROJECT, never inferring one', () => {
    for (const bad of [undefined, '', '0', '-3', '1.5', 'abc']) {
      expect(() => runNotesReposCommand(store, bad, ['notes', '--repos', 'api'])).toThrow(
        /notes --repos needs KARST_PROJECT/,
      );
    }
  });
});
