import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openStore, type Store } from '../../store/db.js';
import { createTicket, updateTicketOnboarding } from '../../store/tickets.js';
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

  it('summarises the current stage with its reason, log and next-step line', () => {
    const t = createTicket(store, { key: 'PROJ-2', title: 'failing' });
    setStage(store, t.id, 'review', {
      status: 'failed',
      verdict: 'gates failed: lint, test',
      artifactPath: '/logs/review-ticket-1.log',
    });
    store.db.prepare("UPDATE tickets SET stage_current = 'review' WHERE id = ?").run(t.id);

    const state = buildDashboardState(store, t.id);
    expect(state.currentStage).toMatchObject({
      stageKey: 'review',
      status: 'failed',
      reason: 'gates failed: lint, test',
      artifactPath: '/logs/review-ticket-1.log',
    });
    expect(state.now.text).toContain('review gate failed');
    expect(state.now.action).toEqual({
      kind: 'open-log',
      label: 'Open log',
      path: '/logs/review-ticket-1.log',
    });
  });

  it('falls back to the not-started line when the ticket sits at no stage', () => {
    const t = createTicket(store, { key: 'PROJ-3', title: 'fresh' });
    store.db.prepare('UPDATE tickets SET stage_current = NULL WHERE id = ?').run(t.id);
    const state = buildDashboardState(store, t.id);
    expect(state.currentStage).toBeNull();
    expect(state.now.text).toBe('Now: not started. Launch a session to begin.');
  });

  it('builds a provider ticket URL from the source ref for a clickup ticket', () => {
    const t = createTicket(store, { key: 'CU-1', title: 't' });
    updateTicketOnboarding(store, t.id, { sourceRef: 'abc123' });
    const state = buildDashboardState(store, t.id, undefined, { provider: 'clickup' });
    expect(state.provider).toBe('clickup');
    expect(state.sourceRef).toBe('abc123');
    expect(state.ticketUrl).toBe('https://app.clickup.com/t/abc123');
  });

  it('has no ticket URL for a manual provider or a missing source ref', () => {
    const manual = createTicket(store, { key: 'M-1', title: 't' });
    updateTicketOnboarding(store, manual.id, { sourceRef: 'abc123' });
    expect(buildDashboardState(store, manual.id, undefined, { provider: 'manual' }).ticketUrl).toBeNull();
    const noRef = createTicket(store, { key: 'CU-2', title: 't' });
    expect(buildDashboardState(store, noRef.id, undefined, { provider: 'clickup' }).ticketUrl).toBeNull();
  });

  it('defaults provider fields to null when no ticketing config is passed', () => {
    const t = createTicket(store, { key: 'N-1', title: 't' });
    updateTicketOnboarding(store, t.id, { sourceRef: 'abc123' });
    const state = buildDashboardState(store, t.id);
    expect(state.provider).toBeNull();
    expect(state.ticketUrl).toBeNull();
  });

  it('resolves the impl-phase breakdown for the ticket approach', () => {
    const t = createTicket(store, { key: 'W-1', title: 't' });
    updateTicketOnboarding(store, t.id, { approach: 'rpi' });
    const phases = (approachId: string | null) =>
      approachId === 'rpi' ? ['research', 'plan', 'implement'] : [];
    const state = buildDashboardState(store, t.id, undefined, undefined, phases);
    expect(state.implPhases).toEqual(['research', 'plan', 'implement']);
  });

  it('defaults implPhases to empty when no resolver or no workflow', () => {
    const t = createTicket(store, { key: 'W-2', title: 't' });
    expect(buildDashboardState(store, t.id).implPhases).toEqual([]);
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
