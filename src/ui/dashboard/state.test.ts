import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openStore, type Store } from '../../store/db.js';
import { createTicket, updateTicketOnboarding } from '../../store/tickets.js';
import { setStage } from '../../store/stages.js';
import { recordGateRun } from '../../store/gateRuns.js';
import { setMergeCheck } from '../../store/mergeChecks.js';
import { STAGE_KEYS } from '../../model/types.js';
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
        `INSERT INTO servers (ticket_id, repo, host, port, pid, status, log_path)
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
      'scope', 'impl', 'uat', 'review', 'fix', 'ship', 'merge', 'done',
    ]);
    expect(state.servers).toHaveLength(1);
    expect(state.servers[0]!.port).toBe(5173);
    expect(state.worktrees).toEqual([]);
    expect(state.prs).toEqual([]);
  });

  it('shows the resolved agent core/model and enables switching only for a live impl session', () => {
    const t = createTicket(store, { key: 'SW-1', title: 'switch' });
    updateTicketOnboarding(store, t.id, { agentProvider: 'codex', model: 'gpt-5.6-sol' });
    store.db.prepare("UPDATE tickets SET stage_current = 'impl' WHERE id = ?").run(t.id);

    const state = buildDashboardState(
      store, t.id, undefined, undefined, undefined, undefined, 'claude',
      { defaultModel: null, isSessionOpen: (id) => id === t.id },
    );

    expect(state.agentSession).toMatchObject({
      provider: 'codex', providerLabel: 'Codex',
      modelId: 'gpt-5.6-sol', modelLabel: 'GPT-5.6 Sol', canSwitch: true,
    });
  });

  it.each([
    ['impl', false], ['fix', false], ['review', true],
  ] as const)('does not offer switching at %s/open=%s', (stage, open) => {
    const t = createTicket(store, { key: `SW-${stage}-${open}`, title: 'switch' });
    store.db.prepare('UPDATE tickets SET stage_current = ? WHERE id = ?').run(stage, t.id);
    const state = buildDashboardState(
      store, t.id, undefined, undefined, undefined, undefined, 'claude',
      { isSessionOpen: () => open },
    );
    expect(state.agentSession.canSwitch).toBe(false);
  });

  // The merge verdicts already feed the ship strip; the PR panel needs them at
  // the top level too, because that is where the conflict is acted on and the
  // webview cannot query the store.
  it('exposes each repo’s current merge verdict alongside the PRs', () => {
    const t = createTicket(store, { key: 'PROJ-1', title: 'thing' });
    setMergeCheck(store, {
      ticketId: t.id,
      repo: 'api',
      state: 'conflicted',
      files: ['src/a.ts'],
      reason: null,
      headSha: 'h',
      baseSha: 'b',
      baseRef: 'main',
      checkedAt: '2026-07-28T12:00:00.000Z',
    });

    const state = buildDashboardState(store, t.id);

    // Fully worded host-side: the webview must never phrase a verdict of its own,
    // and the age is relative to the push, so only the fixed parts are pinned.
    expect(state.mergeChecks).toHaveLength(1);
    const row = state.mergeChecks[0]!;
    expect(row.repo).toBe('api');
    expect(row.state).toBe('conflicted');
    expect(row.headline).toMatch(/^conflicted · 1 file · vs main · /);
    expect(row.detailsLabel).toBe('1 conflicting file');
    expect(row.files).toEqual(['src/a.ts']);
    expect(row.reason).toBe('');
    expect(row.checkedTitle).not.toBe('');
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

  it('carries a blocked stage’s kind/reason/at through to currentStage', () => {
    const t = createTicket(store, { key: 'PROJ-4', title: 'parked' });
    setStage(store, t.id, 'review', {
      status: 'running',
      blockedKind: 'nothing-to-run',
      blockedReason: 'no target resolved',
      blockedAt: '2026-07-16T10:00:00.000Z',
    });
    store.db.prepare("UPDATE tickets SET stage_current = 'review' WHERE id = ?").run(t.id);

    const state = buildDashboardState(store, t.id);
    expect(state.currentStage?.blocked).toEqual({
      kind: 'nothing-to-run',
      reason: 'no target resolved',
      at: '2026-07-16T10:00:00.000Z',
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

  it('names the approach driving impl and its declared phases', () => {
    const t = createTicket(store, { key: 'W-1', title: 't' });
    updateTicketOnboarding(store, t.id, { approach: 'rpi' });
    const phases = (approachId: string | null) =>
      approachId === 'rpi' ? ['research', 'plan', 'implement'] : [];
    const state = buildDashboardState(store, t.id, undefined, undefined, phases);
    expect(state.approach).toEqual({ id: 'rpi', phases: ['research', 'plan', 'implement'] });
  });

  it('has no approach when the ticket was never given one', () => {
    const t = createTicket(store, { key: 'W-2', title: 't' });
    expect(buildDashboardState(store, t.id).approach).toBeNull();
  });

  it('keeps fix off the rail and carries it as the branch', () => {
    // The bug: projecting all seven stage keys onto a line drew fix as a step
    // between review and ship, a forward path the graph does not have.
    const t = createTicket(store, { key: 'R-1', title: 't' });
    const state = buildDashboardState(store, t.id);
    expect(state.rail.main.map((c) => c.stageKey)).not.toContain('fix');
    expect(state.rail.branch.stageKey).toBe('fix');
  });

  it('precomputes a strip for every stage, so any stage can be selected', () => {
    const t = createTicket(store, { key: 'R-2', title: 't' });
    const state = buildDashboardState(store, t.id);
    for (const key of STAGE_KEYS) {
      expect(state.inside[key]?.stageKey, `missing strip: ${key}`).toBe(key);
    }
  });

  it('carries recorded gate evidence into the review strip', () => {
    const t = createTicket(store, { key: 'R-3', title: 't' });
    setStage(store, t.id, 'review', { status: 'failed', verdict: 'gates failed: lint' });
    recordGateRun(store, {
      ticketId: t.id,
      stageKey: 'review',
      attempt: 0,
      runAt: '2026-07-20T12:00:00.000Z',
      gates: [
        { gateName: 'lint', exitCode: 1 },
        { gateName: 'typecheck', exitCode: 0 },
        { gateName: 'test', exitCode: null },
      ],
    });

    const ops = buildDashboardState(store, t.id).inside.review.ops;
    expect(ops.find((o) => o.name === 'lint')?.status).toBe('fail');
    expect(ops.find((o) => o.name === 'typecheck')?.status).toBe('pass');
    // The repo defines no test script — not a pass karst can claim.
    expect(ops.find((o) => o.name === 'test')?.status).toBe('note');
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

describe('buildDashboardState — runnable scope', () => {
  let store: Store;
  beforeEach(() => (store = openStore(':memory:')));

  function scoped(repos: string[]): number {
    const t = createTicket(store, { key: 'P-1', title: 'x' });
    updateTicketOnboarding(store, t.id, { selectedRepos: repos });
    return t.id;
  }

  // A ticket scoping only non-runnable repos can never have a server, so the
  // dashboard must not offer a Start button for it.
  it('reports hasRunnableRepos false when nothing in scope declares a service', () => {
    const id = scoped(['docs']);
    const s = buildDashboardState(store, id, undefined, undefined, undefined, () => false);
    expect(s.hasRunnableRepos).toBe(false);
  });

  it('reports true when at least one scoped repo is runnable', () => {
    const id = scoped(['docs', 'api']);
    const s = buildDashboardState(store, id, undefined, undefined, undefined, (r) => r === 'api');
    expect(s.hasRunnableRepos).toBe(true);
  });

  it('assumes runnable when the caller injects nothing (manifest unresolved)', () => {
    const id = scoped(['docs']);
    expect(buildDashboardState(store, id).hasRunnableRepos).toBe(true);
  });

  it('reports false for an empty scope — there is nothing to start', () => {
    expect(buildDashboardState(store, scoped([])).hasRunnableRepos).toBe(false);
  });
});
