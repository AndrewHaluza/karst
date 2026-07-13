import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openStore, type Store } from '../../store/db.js';
import { createTicket } from '../../store/tickets.js';
import { setStage } from '../../store/stages.js';
import { buildDashboardState } from './state.js';

describe('buildDashboardState', () => {
  let store: Store;
  beforeEach(() => (store = openStore(':memory:')));
  afterEach(() => store.close());

  it('collects ticket, ordered stepper, servers, worktrees, prs', () => {
    const t = createTicket(store, { key: 'PROJ-1', title: 'thing' });
    setStage(store, t.id, 'scope', { status: 'passed' });
    store.db
      .prepare(
        `INSERT INTO servers (ticket_id, service, host, port, pid, status, log_path)
         VALUES (?, 'web', 'localhost', 5173, 1, 'running', '/tmp/x')`,
      )
      .run(t.id);

    const state = buildDashboardState(store, t.id);
    expect(state.ticketId).toBe(t.id);
    expect(state.title).toBe('thing');
    expect(state.stageCurrent).toBe('scope');
    // stepper ordered by STAGE_KEYS, scope first + passed
    expect(state.stepper[0]!.stageKey).toBe('scope');
    expect(state.stepper[0]!.status).toBe('passed');
    expect(state.stepper.map((s) => s.stageKey)).toEqual([
      'scope', 'impl', 'uat', 'review', 'fix', 'ship', 'done',
    ]);
    expect(state.servers).toHaveLength(1);
    expect(state.servers[0]!.port).toBe(5173);
    expect(state.worktrees).toEqual([]);
    expect(state.prs).toEqual([]);
  });

  it('throws for an unknown ticket', () => {
    expect(() => buildDashboardState(store, 999)).toThrow();
  });

  function seedWorktree(ticketId: number, repo: string): void {
    store.db
      .prepare(
        `INSERT INTO worktrees (ticket_id, repo, path, branch, base_ref, deps_mode)
         VALUES (?, ?, ?, 'karst/x', 'develop', 'inherited')`,
      )
      .run(ticketId, repo, `${repo}/.karst/worktrees/x`);
  }

  it('defaults worktree repoDisplay to the absolute repo path', () => {
    const t = createTicket(store, { key: 'P', title: 't' });
    seedWorktree(t.id, '/Users/nd/Work/projects/tatto-timer');
    const state = buildDashboardState(store, t.id);
    expect(state.worktrees[0]!.repoDisplay).toBe('/Users/nd/Work/projects/tatto-timer');
  });

  it('renders ./<name> when the repo IS the workspace root (single-repo case)', () => {
    const t = createTicket(store, { key: 'P', title: 't' });
    seedWorktree(t.id, '/Users/nd/Work/projects/tatto-timer');
    const state = buildDashboardState(store, t.id, {
      display: 'relative',
      projectRoot: '/Users/nd/Work/projects/tatto-timer',
    });
    expect(state.worktrees[0]!.repoDisplay).toBe('./tatto-timer');
  });

  it('renders ./sub for a repo nested under the workspace root', () => {
    const t = createTicket(store, { key: 'P', title: 't' });
    seedWorktree(t.id, '/Users/nd/Work/projects/mono/frontend');
    const state = buildDashboardState(store, t.id, {
      display: 'relative',
      projectRoot: '/Users/nd/Work/projects/mono',
    });
    expect(state.worktrees[0]!.repoDisplay).toBe('./frontend');
  });

  it('renders ../name for a sibling repo outside the workspace root', () => {
    const t = createTicket(store, { key: 'P', title: 't' });
    seedWorktree(t.id, '/Users/nd/Work/projects/other-repo');
    const state = buildDashboardState(store, t.id, {
      display: 'relative',
      projectRoot: '/Users/nd/Work/projects/tatto-timer',
    });
    expect(state.worktrees[0]!.repoDisplay).toBe('../other-repo');
  });
});
