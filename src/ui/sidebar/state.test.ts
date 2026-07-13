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

    const state = buildSidebarState(store, { facet: 'all', filter: '' });
    expect(state.rows.map((r) => r.label)).toEqual(['A-1 — active']);
    expect(state.facet).toBe('all');
  });

  it('archived facet lists only archived tickets', () => {
    createTicket(store, { key: 'A-1', title: 'active' });
    const gone = createTicket(store, { key: 'B-1', title: 'archived' });
    archiveTicket(store, gone.id);

    const state = buildSidebarState(store, { facet: 'archived', filter: '' });
    expect(state.rows.map((r) => r.ticketId)).toEqual([gone.id]);
    expect(state.rows[0]!.archived).toBe(true);
  });

  it('running facet narrows to running-stage tickets', () => {
    const r = createTicket(store, { key: 'R-1', title: 'running' });
    setStage(store, r.id, 'scope', { status: 'running' });
    createTicket(store, { key: 'P-1', title: 'pending' });

    const state = buildSidebarState(store, { facet: 'running', filter: '' });
    expect(state.rows.map((x) => x.ticketId)).toEqual([r.id]);
  });

  it('filter narrows by key/title, case-insensitive', () => {
    createTicket(store, { key: 'A-1', title: 'add login' });
    createTicket(store, { key: 'B-1', title: 'fix logout' });

    const state = buildSidebarState(store, { facet: 'all', filter: 'LOGIN' });
    expect(state.rows.map((r) => r.label)).toEqual(['A-1 — add login']);
  });

  it('counts reflect the full active list + archived total, not the filter', () => {
    createTicket(store, { key: 'A-1', title: 'add login' });
    const gone = createTicket(store, { key: 'B-1', title: 'gone' });
    archiveTicket(store, gone.id);

    const state = buildSidebarState(store, { facet: 'all', filter: 'login' });
    expect(state.rows).toHaveLength(1); // filtered
    expect(state.counts.all).toBe(1); // one active ticket total
    expect(state.counts.archived).toBe(1);
  });

  it('rows carry the ticket servers and worktrees for the expanded body', () => {
    const t = createTicket(store, { key: 'A-1', title: 'has infra' });
    store.db
      .prepare("INSERT INTO servers (ticket_id, service, host, port, status) VALUES (?,?,?,?, 'running')")
      .run(t.id, 'backend', 'localhost', 4000);
    store.db
      .prepare('INSERT INTO worktrees (ticket_id, repo, path, branch) VALUES (?,?,?,?)')
      .run(t.id, 'backend', '/wt/backend', 'feature/A-1');

    const state = buildSidebarState(store, { facet: 'all', filter: '' });
    const row = state.rows[0]!;
    expect(row.servers.map((s) => s.service)).toEqual(['backend']);
    expect(row.worktrees.map((w) => w.repo)).toEqual(['backend']);
  });

  it('worktree repoDisplay is the absolute repo path when no PathContext given', () => {
    const t = createTicket(store, { key: 'A-1', title: 'wt' });
    store.db
      .prepare('INSERT INTO worktrees (ticket_id, repo, path, branch) VALUES (?,?,?,?)')
      .run(t.id, '/Users/nd/Work/projects/tatto-timer', '/wt/tt', 'feature/A-1');

    const state = buildSidebarState(store, { facet: 'all', filter: '' });
    expect(state.rows[0]!.worktrees[0]!.repoDisplay).toBe('/Users/nd/Work/projects/tatto-timer');
  });

  it('worktree repoDisplay is project-relative under a relative PathContext', () => {
    const t = createTicket(store, { key: 'A-1', title: 'wt' });
    store.db
      .prepare('INSERT INTO worktrees (ticket_id, repo, path, branch) VALUES (?,?,?,?)')
      .run(t.id, '/Users/nd/Work/projects/tatto-timer', '/wt/tt', 'feature/A-1');

    const state = buildSidebarState(
      store,
      { facet: 'all', filter: '' },
      { display: 'relative', projectRoot: '/Users/nd/Work/projects/tatto-timer' },
    );
    // repo IS the workspace root → `./<name>` (the bug's single-repo case).
    expect(state.rows[0]!.worktrees[0]!.repoDisplay).toBe('./tatto-timer');
  });
});
