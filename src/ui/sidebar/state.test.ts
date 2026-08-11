import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openStore, type Store } from '../../store/db.js';
import { createTicket, archiveTicket } from '../../store/tickets.js';
import { setStage } from '../../store/stages.js';
import { buildSidebarState } from './state.js';

describe('buildSidebarState', () => {
  let store: Store;
  beforeEach(() => (store = openStore(':memory:')));
  afterEach(() => store.close());

  it('default (all) facet excludes archived and returns active rows', () => {
    createTicket(store, { key: 'A-1', title: 'active' });
    const gone = createTicket(store, { key: 'B-1', title: 'archived' });
    archiveTicket(store, gone.id);

    const state = buildSidebarState(store, { facets: ['all'], filter: '' });
    expect(state.rows.map((r) => r.label)).toEqual(['A-1 — active']);
    expect(state.facets).toEqual(['all']);
  });

  it('shows only the bound project when one is given', () => {
    createTicket(store, { key: 'A-1', title: 'mine', projectId: 1 });
    createTicket(store, { key: 'B-1', title: 'theirs', projectId: 2 });

    const state = buildSidebarState(store, { facets: ['all'], filter: '', projectId: 1 });
    expect(state.rows.map((r) => r.label)).toEqual(['A-1 — mine']);
  });

  it('scopes the archived facet to the bound project too', () => {
    const mine = createTicket(store, { key: 'A-1', title: 'mine', projectId: 1 });
    const theirs = createTicket(store, { key: 'B-1', title: 'theirs', projectId: 2 });
    archiveTicket(store, mine.id);
    archiveTicket(store, theirs.id);

    const state = buildSidebarState(store, { facets: ['archived'], filter: '', projectId: 1 });
    expect(state.rows.map((r) => r.ticketId)).toEqual([mine.id]);
  });

  it('counts reflect only the bound project, so the chips do not leak', () => {
    createTicket(store, { key: 'A-1', title: 'mine', projectId: 1 });
    createTicket(store, { key: 'B-1', title: 'theirs', projectId: 2 });
    const other = createTicket(store, { key: 'B-2', title: 'theirs archived', projectId: 2 });
    archiveTicket(store, other.id);

    const state = buildSidebarState(store, { facets: ['all'], filter: '', projectId: 1 });
    expect(state.counts.all).toBe(1);
    expect(state.counts.archived).toBe(0);
  });

  it('archived facet lists only archived tickets', () => {
    createTicket(store, { key: 'A-1', title: 'active' });
    const gone = createTicket(store, { key: 'B-1', title: 'archived' });
    archiveTicket(store, gone.id);

    const state = buildSidebarState(store, { facets: ['archived'], filter: '' });
    expect(state.rows.map((r) => r.ticketId)).toEqual([gone.id]);
    expect(state.rows[0]!.archived).toBe(true);
  });

  it('running facet narrows to running-stage tickets', () => {
    const r = createTicket(store, { key: 'R-1', title: 'running' });
    setStage(store, r.id, 'scope', { status: 'running' });
    createTicket(store, { key: 'P-1', title: 'pending' });

    const state = buildSidebarState(store, { facets: ['running'], filter: '' });
    expect(state.rows.map((x) => x.ticketId)).toEqual([r.id]);
  });

  it('a multi-status selection returns the union (fix: several statuses at once)', () => {
    const r = createTicket(store, { key: 'R-1', title: 'running' });
    setStage(store, r.id, 'scope', { status: 'running' });
    const f = createTicket(store, { key: 'F-1', title: 'failed' });
    setStage(store, f.id, 'scope', { status: 'failed' });
    createTicket(store, { key: 'P-1', title: 'pending' });

    const state = buildSidebarState(store, { facets: ['running', 'failed'], filter: '' });
    expect(state.rows.map((x) => x.ticketId).sort()).toEqual([r.id, f.id].sort());
    expect(state.facets).toEqual(['running', 'failed']);
  });

  it('filter narrows by key/title, case-insensitive', () => {
    createTicket(store, { key: 'A-1', title: 'add login' });
    createTicket(store, { key: 'B-1', title: 'fix logout' });

    const state = buildSidebarState(store, { facets: ['all'], filter: 'LOGIN' });
    expect(state.rows.map((r) => r.label)).toEqual(['A-1 — add login']);
  });

  it('counts reflect the full active list + archived total, not the filter', () => {
    createTicket(store, { key: 'A-1', title: 'add login' });
    const gone = createTicket(store, { key: 'B-1', title: 'gone' });
    archiveTicket(store, gone.id);

    const state = buildSidebarState(store, { facets: ['all'], filter: 'login' });
    expect(state.rows).toHaveLength(1); // filtered
    expect(state.counts.all).toBe(1); // one active ticket total
    expect(state.counts.archived).toBe(1);
  });

  it('rows carry the ticket servers and worktrees for the expanded body', () => {
    const t = createTicket(store, { key: 'A-1', title: 'has infra' });
    store.db
      .prepare("INSERT INTO servers (ticket_id, repo, host, port, status) VALUES (?,?,?,?, 'running')")
      .run(t.id, 'backend', 'localhost', 4000);
    store.db
      .prepare('INSERT INTO worktrees (ticket_id, repo, path, branch) VALUES (?,?,?,?)')
      .run(t.id, 'backend', '/wt/backend', 'feature/A-1');

    const state = buildSidebarState(store, { facets: ['all'], filter: '' });
    const row = state.rows[0]!;
    expect(row.servers.map((s) => s.service)).toEqual(['backend']);
    expect(row.worktrees.map((w) => w.repo)).toEqual(['backend']);
  });

  it('worktree repoDisplay is the absolute repo path when no PathContext given', () => {
    const t = createTicket(store, { key: 'A-1', title: 'wt' });
    store.db
      .prepare('INSERT INTO worktrees (ticket_id, repo, path, branch) VALUES (?,?,?,?)')
      .run(t.id, '/Users/nd/Work/projects/tatto-timer', '/wt/tt', 'feature/A-1');

    const state = buildSidebarState(store, { facets: ['all'], filter: '' });
    expect(state.rows[0]!.worktrees[0]!.repoDisplay).toBe('/Users/nd/Work/projects/tatto-timer');
  });

  it('worktree repoDisplay is project-relative under a relative PathContext', () => {
    const t = createTicket(store, { key: 'A-1', title: 'wt' });
    store.db
      .prepare('INSERT INTO worktrees (ticket_id, repo, path, branch) VALUES (?,?,?,?)')
      .run(t.id, '/Users/nd/Work/projects/tatto-timer', '/wt/tt', 'feature/A-1');

    const state = buildSidebarState(
      store,
      { facets: ['all'], filter: '' },
      { display: 'relative', projectRoot: '/Users/nd/Work/projects/tatto-timer' },
    );
    // repo IS the workspace root → `./<name>` (the bug's single-repo case).
    expect(state.rows[0]!.worktrees[0]!.repoDisplay).toBe('./tatto-timer');
  });

  it("resolves a follow-up row's parentKey even when the parent sits in a different facet", () => {
    const parent = createTicket(store, { key: 'PROJ-1', title: 'root' });
    store.db.prepare("UPDATE tickets SET stage_current = 'done' WHERE id = ?").run(parent.id);
    archiveTicket(store, parent.id); // parent is archived; child is not
    createTicket(store, { key: 'PROJ-1-fu1', title: 'follow-up', parentTicketId: parent.id });

    const state = buildSidebarState(store, { facets: ['all'], filter: '' });
    const child = state.rows.find((r) => r.label.startsWith('PROJ-1-fu1'));
    expect(child?.parentKey).toBe('PROJ-1');
  });

  it('marks only the active ticket row when activeTicketId matches', () => {
    const a = createTicket(store, { key: 'A-1', title: 'first' });
    const b = createTicket(store, { key: 'B-1', title: 'second' });

    const state = buildSidebarState(store, { facets: ['all'], filter: '', activeTicketId: b.id });
    expect(state.rows.find((r) => r.ticketId === a.id)?.isActive).toBe(false);
    expect(state.rows.find((r) => r.ticketId === b.id)?.isActive).toBe(true);
  });

  it('marks no row active when activeTicketId is absent or null', () => {
    createTicket(store, { key: 'A-1', title: 'first' });

    for (const activeTicketId of [undefined, null]) {
      const state = buildSidebarState(store, { facets: ['all'], filter: '', activeTicketId });
      expect(state.rows.every((r) => r.isActive === false)).toBe(true);
    }
  });

  it('keeps the active mark off rows a facet hides (nothing to highlight there)', () => {
    const a = createTicket(store, { key: 'A-1', title: 'active ticket' });
    archiveTicket(store, a.id);

    const state = buildSidebarState(store, { facets: ['all'], filter: '', activeTicketId: a.id });
    expect(state.rows).toHaveLength(0);
  });
});
