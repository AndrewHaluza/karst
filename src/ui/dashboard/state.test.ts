import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openStore, type Store } from '../../store/db.js';
import { createTicket, updateTicketFields } from '../../store/tickets.js';
import { setStage } from '../../store/stages.js';
import { recordGateRun } from '../../store/gateRuns.js';
import { setMergeCheck } from '../../store/mergeChecks.js';
import { recordPhaseMark } from '../../store/phaseMarks.js';
import { recordTokenUsage } from '../../store/tokenUsage.js';
import { openProcessRun } from '../../store/processRuns.js';
import { parkGateStage } from '../../store/stageBlocks.js';
import { MAX_DIAGNOSTIC_CHARS } from '../../model/diagnosticText.js';
import { InsideActionRegistry } from './insideActions.js';
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
      'scope', 'impl', 'uat', 'review', 'fix', 'ship', 'done',
    ]);
    expect(state.servers).toHaveLength(1);
    expect(state.servers[0]!.port).toBe(5173);
    expect(state.worktrees).toEqual([]);
    expect(state.prs).toEqual([]);
    // No evidence → no artifacts section (spec §4.1: absence, never empty).
    expect(state.artifacts).toEqual([]);
  });

  it('carries the parent relationship for a follow-up and null otherwise', () => {
    const parent = createTicket(store, { key: 'PROJ-1', title: 'root work' });
    const child = createTicket(store, {
      key: 'PROJ-1-fu1',
      title: 'root work',
      parentTicketId: parent.id,
    });
    const childState = buildDashboardState(store, child.id);
    expect(childState.parent).toEqual({ key: 'PROJ-1', title: 'root work' });
    expect(buildDashboardState(store, parent.id).parent).toBeNull();
  });

  it('degrades to null when the linked parent was hard-deleted', () => {
    const parent = createTicket(store, { key: 'PROJ-1', title: 'root work' });
    const child = createTicket(store, {
      key: 'PROJ-1-fu1',
      title: 'root work',
      parentTicketId: parent.id,
    });
    store.db.prepare('DELETE FROM tickets WHERE id = ?').run(parent.id);
    expect(buildDashboardState(store, child.id).parent).toBeNull();
  });

  it('derives the artifacts shelf from the same evidence the inside view renders', () => {
    const t = createTicket(store, { key: 'ART-ST', title: 'artifacts' });
    store.db.prepare("UPDATE tickets SET stage_current = 'uat' WHERE id = ?").run(t.id);
    setStage(store, t.id, 'uat', { status: 'passed', startedAt: '2026-08-01T09:00:00.000Z', endedAt: '2026-08-01T10:00:00.000Z' });
    recordGateRun(store, {
      ticketId: t.id,
      stageKey: 'uat',
      attempt: 0,
      runAt: '2026-08-01T09:30:00.000Z',
      gates: [{ gateName: 'test', exitCode: 0, repo: '/wt/web' }],
    });

    const state = buildDashboardState(store, t.id);
    expect(state.artifacts).toHaveLength(1);
    expect(state.artifacts[0]).toMatchObject({ id: 'uat-report', status: 'passed' });
  });

  it('passes the real estimated call count into the session process token view', () => {
    const t = createTicket(store, { key: 'TK-1', title: 'tokens' });
    const run = openProcessRun(store, {
      ticketId: t.id, stageKey: 'impl', processId: 'session', attempt: 0,
      startedAt: '2026-08-01T10:00:00.000Z',
    });
    recordTokenUsage(store, {
      projectId: null, ticketId: t.id, processRunId: run.id, callSite: 'impl-run',
      provider: 'codex', outcome: 'ok', recordedAt: '2026-08-01T10:01:00.000Z',
      usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0,
               totalTokens: 150, model: 'gpt-5.6-sol', estimated: false },
    });
    recordTokenUsage(store, {
      projectId: null, ticketId: t.id, processRunId: run.id, callSite: 'impl-run',
      provider: 'codex', outcome: 'ok', recordedAt: '2026-08-01T10:02:00.000Z',
      usage: { inputTokens: 999, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
               totalTokens: 999, model: 'gpt-5.6-sol', estimated: true },
    });

    // The count is a real fact from the ledger, never the hardcoded 0: the
    // mixed measured + estimated process reads as estimated.
    const state = buildDashboardState(store, t.id);
    const session = state.insideViews.impl.processes.find((p) => p.id === 'session')!;
    expect(session.tokens).toMatchObject({ state: 'estimated' });
  });

  it('shows the resolved agent core/model and enables switching only for a live impl session', () => {
    const t = createTicket(store, { key: 'SW-1', title: 'switch' });
    updateTicketFields(store, t.id, { agentProvider: 'codex', model: 'gpt-5.6-sol' });
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

  it('does not offer switching while a Fix recovery execution owns the live session', () => {
    const t = createTicket(store, { key: 'SW-FIX', title: 'switch' });
    store.db.prepare("UPDATE tickets SET stage_current = 'fix' WHERE id = ?").run(t.id);
    store.db.prepare(
      `INSERT INTO recovery_rounds
         (ticket_id, source_stage, source_process_id, trigger_kind, trigger_detail,
          round, max_rounds, status, started_at)
       VALUES (?, 'uat', 'gates', 'gate-failure', 'test failed', 1, 3, 'fixing', ?)`,
    ).run(t.id, '2026-08-09T10:00:00.000Z');

    const state = buildDashboardState(
      store, t.id, undefined, undefined, undefined, undefined, 'claude',
      { isSessionOpen: () => true },
    );

    expect(state.agentSession.canSwitch).toBe(false);
  });

  it('exposes the header agent-switch choices for every implemented core', () => {
    const t = createTicket(store, { key: 'SW-CH', title: 'switch' });
    const state = buildDashboardState(store, t.id);
    expect(state.agentSwitch.cores.map((c) => c.id)).toEqual(['claude', 'codex', 'antigravity', 'opencode']);
    expect(state.agentSwitch.cores.find((c) => c.id === 'codex')?.label).toBe('Codex');
    expect(Array.isArray(state.agentSwitch.models.codex)).toBe(true);
    expect(state.agentSwitch.models.codex!.some((m) => m.model === null)).toBe(true); // inherit choice
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
      resumable: true,
    });
  });

  it('ends a blocked stage’s elapsed clock at the block, never at now', () => {
    // `parkGateStage` leaves the runner's `running` status in place; the strip
    // header must not keep counting against a stage that stopped the moment it
    // parked. The block carries its own timestamp — that is the end.
    const t = createTicket(store, { key: 'PROJ-BLK', title: 'parked clock' });
    setStage(store, t.id, 'uat', { status: 'running', startedAt: '2026-08-09T10:00:00.000Z' });
    parkGateStage(store, {
      ticketId: t.id,
      stageKey: 'uat',
      kind: 'nothing-to-run',
      reason: 'no target resolved',
      runAt: '2026-08-09T10:33:42.000Z',
      gates: [],
    });
    store.db.prepare("UPDATE tickets SET stage_current = 'uat' WHERE id = ?").run(t.id);

    const state = buildDashboardState(store, t.id);
    expect(state.insideViews.uat.clock).toContain('· 33m 42s elapsed');
    expect(state.insideViews.uat.clock).not.toContain('h elapsed');
  });

  // The reviewer's Important finding (task 8, fix round 1): `reason`/`blocked`
  // arrive from raw git/CLI stderr and reach the blocked banner
  // verbatim unless collapsed and capped BEFORE they land in DashboardState —
  // the webview does nothing but `esc()` them. This exercises the real
  // buildDashboardState path (store → stepper → state), not the collapse
  // helper in isolation.
  it('delivers a multi-line, over-length failed-stage reason to the state as one capped line', () => {
    const t = createTicket(store, { key: 'PROJ-5', title: 'noisy failure' });
    const noisy = `error: something broke\n${'z'.repeat(MAX_DIAGNOSTIC_CHARS + 200)}\nmore lines\nand more`;
    setStage(store, t.id, 'review', { status: 'failed', verdict: noisy });
    store.db.prepare("UPDATE tickets SET stage_current = 'review' WHERE id = ?").run(t.id);

    const state = buildDashboardState(store, t.id);
    const reason = state.currentStage!.reason!;
    expect(reason).not.toContain('\n');
    expect(reason.length).toBeLessThanOrEqual(MAX_DIAGNOSTIC_CHARS + 1);
    expect(reason.endsWith('…')).toBe(true);
  });

  it('delivers a multi-line, over-length blocked reason to the state as one capped line', () => {
    const t = createTicket(store, { key: 'PROJ-6', title: 'noisy block' });
    const noisy = `cannot determine review changes:\n${'q'.repeat(MAX_DIAGNOSTIC_CHARS + 200)}\nfatal: not a repo`;
    setStage(store, t.id, 'review', {
      status: 'running',
      blockedKind: 'capability-missing',
      blockedReason: noisy,
      blockedAt: '2026-07-16T10:00:00.000Z',
    });
    store.db.prepare("UPDATE tickets SET stage_current = 'review' WHERE id = ?").run(t.id);

    const state = buildDashboardState(store, t.id);
    const reason = state.currentStage!.blocked!.reason;
    expect(reason).not.toContain('\n');
    expect(reason.length).toBeLessThanOrEqual(MAX_DIAGNOSTIC_CHARS + 1);
    expect(reason.endsWith('…')).toBe(true);
  });

  it('falls back to the not-started line when the ticket sits at no stage', () => {
    const t = createTicket(store, { key: 'PROJ-3', title: 'fresh' });
    store.db.prepare('UPDATE tickets SET stage_current = NULL WHERE id = ?').run(t.id);
    const state = buildDashboardState(store, t.id);
    expect(state.currentStage).toBeNull();
    expect(state.ship).toEqual({ kind: 'none' });
  });

  it('builds a provider ticket URL from the source ref for a clickup ticket', () => {
    const t = createTicket(store, { key: 'CU-1', title: 't' });
    updateTicketFields(store, t.id, { sourceRef: 'abc123' });
    const state = buildDashboardState(store, t.id, undefined, { provider: 'clickup' });
    expect(state.provider).toBe('clickup');
    expect(state.sourceRef).toBe('abc123');
    expect(state.ticketUrl).toBe('https://app.clickup.com/t/abc123');
  });

  it('has no ticket URL for a manual provider or a missing source ref', () => {
    const manual = createTicket(store, { key: 'M-1', title: 't' });
    updateTicketFields(store, manual.id, { sourceRef: 'abc123' });
    expect(buildDashboardState(store, manual.id, undefined, { provider: 'manual' }).ticketUrl).toBeNull();
    const noRef = createTicket(store, { key: 'CU-2', title: 't' });
    expect(buildDashboardState(store, noRef.id, undefined, { provider: 'clickup' }).ticketUrl).toBeNull();
  });

  it('defaults provider fields to null when no ticketing config is passed', () => {
    const t = createTicket(store, { key: 'N-1', title: 't' });
    updateTicketFields(store, t.id, { sourceRef: 'abc123' });
    const state = buildDashboardState(store, t.id);
    expect(state.provider).toBeNull();
    expect(state.ticketUrl).toBeNull();
  });

  it('names the approach driving impl and its declared phases', () => {
    const t = createTicket(store, { key: 'W-1', title: 't' });
    updateTicketFields(store, t.id, { approach: 'rpi' });
    const phases = (approachId: string | null) =>
      approachId === 'rpi' ? ['research', 'plan', 'implement'] : [];
    const state = buildDashboardState(store, t.id, undefined, undefined, phases);
    expect(state.approach).toEqual({
      id: 'rpi',
      phases: ['research', 'plan', 'implement'],
      reported: [],
    });
  });

  it('has no approach when the ticket was never given one', () => {
    const t = createTicket(store, { key: 'W-2', title: 't' });
    expect(buildDashboardState(store, t.id).approach).toBeNull();
  });

  it('keeps fix off the track — it is drawn on the gate it retries', () => {
    // The bug: projecting all eight stage keys onto a line drew fix as a step
    // between review and ship, a forward path the graph does not have.
    const t = createTicket(store, { key: 'R-1', title: 't' });
    const state = buildDashboardState(store, t.id);
    expect(state.rail.main.map((s) => s.cell.stageKey)).not.toContain('fix');
    expect(state.rail.main.every((s) => s.retry === null)).toBe(true);
  });

  it('marks the current segment needs-you when the ticket is parked at ship', () => {
    // ship is a CONFIRM stage: nothing runs, and the ticket waits on a click.
    // Every other surface already reports this; the rail was the last that did not.
    const t = createTicket(store, { key: 'N-1', title: 't' });
    setStage(store, t.id, 'ship', { status: 'pending' });
    store.db.prepare("UPDATE tickets SET stage_current = 'ship' WHERE id = ?").run(t.id);

    const state = buildDashboardState(store, t.id);
    const ship = state.rail.main.find((s) => s.cell.stageKey === 'ship')!;
    expect(ship.needsUser).toBe(true);
    expect(ship.needs).toEqual({ detail: 'ready to open the PRs', action: 'Confirm ship' });
    expect(state.rail.main.filter((s) => s.needsUser)).toHaveLength(1);
  });

  it('puts needs-you on impl when the agent is the one waiting', () => {
    const t = createTicket(store, { key: 'N-2', title: 't' });
    setStage(store, t.id, 'impl', { status: 'running' });
    store.db
      .prepare("UPDATE tickets SET stage_current = 'impl', agent_state = 'waiting' WHERE id = ?")
      .run(t.id);

    const state = buildDashboardState(store, t.id);
    const impl = state.rail.main.find((s) => s.cell.stageKey === 'impl')!;
    expect(impl.needsUser).toBe(true);
    expect(impl.needs?.action).toBe('Open session');
    expect(state.rail.main.filter((s) => s.needsUser)).toHaveLength(1);
  });

  it('does NOT mark a RUNNING ship needs-you when the agent state reads waiting', () => {
    // The hook that set 'waiting' fired inside ship's own headless run: the
    // ticket is shipping, not parked on the user (869ed7bpd). Every surface —
    // the rail segment, its wording, and the Now line — must read "shipping".
    const t = createTicket(store, { key: 'N-5', title: 't' });
    setStage(store, t.id, 'ship', { status: 'running' });
    store.db
      .prepare("UPDATE tickets SET stage_current = 'ship', agent_state = 'waiting' WHERE id = ?")
      .run(t.id);

    const state = buildDashboardState(store, t.id);
    const ship = state.rail.main.find((s) => s.cell.stageKey === 'ship')!;
    expect(ship.needsUser).toBe(false);
    expect(state.rail.main.every((s) => s.needs === null)).toBe(true);
  });

  it('reads a resolve session at a conflicted ship as in-progress, not needs-you', () => {
    // The user clicked "Resolve conflicts": the session is actively working,
    // so the ticket must read in progress. The awaiting-merge block stays
    // stored (`settleShipGate` needs it) — only its needs-you READING yields,
    // on every surface at once: the rail loses the needs wording, and the Now
    // line stops instructing the user to resolve what the agent is resolving.
    const t = createTicket(store, { key: 'N-6', title: 't' });
    setStage(store, t.id, 'ship', {
      status: 'passed',
      endedAt: '2026-08-01T10:00:00.000Z',
      blockedKind: 'awaiting-merge',
      blockedReason: 'blocked: the pull request for "api" is not merged yet',
      blockedAt: '2026-08-01T10:00:00.000Z',
    });
    store.db
      .prepare("UPDATE tickets SET stage_current = 'ship', agent_state = 'running' WHERE id = ?")
      .run(t.id);
    store.db
      .prepare('INSERT INTO prs (ticket_id, repo, number, url, status) VALUES (?, ?, ?, ?, ?)')
      .run(t.id, 'api', 12, 'https://github.com/o/r/pull/12', 'open');
    setMergeCheck(store, {
      ticketId: t.id,
      repo: 'api',
      state: 'conflicted',
      files: ['src/a.ts'],
      reason: null,
      headSha: 'h',
      baseSha: 'b',
      baseRef: 'main',
      checkedAt: '2026-08-01T10:00:00.000Z',
    });

    const state = buildDashboardState(store, t.id);
    const ship = state.rail.main.find((s) => s.cell.stageKey === 'ship')!;
    expect(ship.needsUser).toBe(false);
    expect(ship.needs).toBeNull();
    expect(state.rail.main.every((s) => s.needs === null)).toBe(true);
  });

  it('returns to needs-you on the same conflicted ship once the session ends', () => {
    // SessionEnd → idle: nobody is working the ticket, so the wait for a human
    // merge click resumes on every surface — the rail and the Now line.
    const t = createTicket(store, { key: 'N-7', title: 't' });
    setStage(store, t.id, 'ship', {
      status: 'passed',
      endedAt: '2026-08-01T10:00:00.000Z',
      blockedKind: 'awaiting-merge',
      blockedReason: 'blocked: the pull request for "api" is not merged yet',
      blockedAt: '2026-08-01T10:00:00.000Z',
    });
    store.db
      .prepare("UPDATE tickets SET stage_current = 'ship', agent_state = 'idle' WHERE id = ?")
      .run(t.id);
    store.db
      .prepare('INSERT INTO prs (ticket_id, repo, number, url, status) VALUES (?, ?, ?, ?, ?)')
      .run(t.id, 'api', 12, 'https://github.com/o/r/pull/12', 'open');
    setMergeCheck(store, {
      ticketId: t.id,
      repo: 'api',
      state: 'conflicted',
      files: ['src/a.ts'],
      reason: null,
      headSha: 'h',
      baseSha: 'b',
      baseRef: 'main',
      checkedAt: '2026-08-01T10:00:00.000Z',
    });

    const state = buildDashboardState(store, t.id);
    const ship = state.rail.main.find((s) => s.cell.stageKey === 'ship')!;
    expect(ship.needsUser).toBe(true);
    expect(ship.needs).toEqual({
      detail: '1 repo no longer merges cleanly',
      action: 'Resolve',
    });
  });

  it('leaves every segment clear when nothing is blocked on the user', () => {
    const t = createTicket(store, { key: 'N-3', title: 't' });
    setStage(store, t.id, 'impl', { status: 'running' });
    store.db.prepare("UPDATE tickets SET stage_current = 'impl' WHERE id = ?").run(t.id);
    const state = buildDashboardState(store, t.id);
    expect(state.rail.main.some((s) => s.needsUser)).toBe(false);
    expect(state.rail.main.every((s) => s.needs === null)).toBe(true);
  });

  it('draws the meter with the manifest’s narrowed uat budget', () => {
    // The meter must draw exactly the attempts the driver will spend, or it lies
    // about how many retries are left.
    const t = createTicket(store, { key: 'N-4', title: 't' });
    setStage(store, t.id, 'uat', { status: 'failed', attempt: 1 });
    store.db.prepare("UPDATE tickets SET stage_current = 'uat' WHERE id = ?").run(t.id);

    const state = buildDashboardState(
      store, t.id, undefined, undefined, undefined, undefined, undefined, undefined,
      () => 1,
    );
    const uat = state.rail.main.find((s) => s.cell.stageKey === 'uat')!;
    expect(uat.retry).toMatchObject({ spent: 1, cap: 1 });
  });

  it('reports which declared phases the agent has actually marked', () => {
    // Declared is not observed: an unmarked phase renders hollow and must never
    // be claimed as done.
    const t = createTicket(store, { key: 'N-5', title: 't' });
    updateTicketFields(store, t.id, { approach: 'rpi' });
    setStage(store, t.id, 'impl', { status: 'running' });
    recordPhaseMark(store, {
      ticketId: t.id,
      stageKey: 'impl',
      attempt: 0,
      phaseName: 'research',
      markedAt: '2026-08-02T10:00:00.000Z',
    });

    const state = buildDashboardState(store, t.id, undefined, undefined, () => [
      'research', 'plan', 'implement',
    ]);
    expect(state.approach).toMatchObject({
      id: 'rpi',
      phases: ['research', 'plan', 'implement'],
      reported: ['research'],
    });
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

  it('marks a worktree launchable only when the probe says it is a karst checkout', () => {
    const t = createTicket(store, { key: 'P', title: 't' });
    seedWorktree(t.id, '/Users/nd/Work/projects/karst');
    const probe = (path: string) => path.includes('karst');
    // isCheckout is the LAST optional param; every position before it must be
    // skipped explicitly (the signature only defaults trailing params).
    const state = buildDashboardState(
      store,
      t.id,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      probe,
    );
    expect(state.worktrees[0]!.launchable).toBe(true);
  });

  it('defaults launchable to false without a probe (never a dead button)', () => {
    const t = createTicket(store, { key: 'P', title: 't' });
    seedWorktree(t.id, '/nope');
    const state = buildDashboardState(store, t.id);
    expect(state.worktrees[0]!.launchable).toBe(false);
  });

  it('flags console on a gate stage whose stage row recorded an artifactPath', () => {
    const t = createTicket(store, { key: 'PROJ-1', title: 'thing' });
    setStage(store, t.id, 'uat', { status: 'passed', artifactPath: '/logs/uat.log' });
    setStage(store, t.id, 'review', { status: 'passed', artifactPath: null });
    const state = buildDashboardState(store, t.id);
    expect(state.insideViews.uat.console).toBe(true);
    expect(state.insideViews.review.console).toBe(false);
  });

  it('never flags a non-gate stage, whatever its artifactPath', () => {
    const t = createTicket(store, { key: 'PROJ-2', title: 'thing' });
    setStage(store, t.id, 'impl', { status: 'passed', artifactPath: '/logs/impl.log' });
    setStage(store, t.id, 'ship', { status: 'passed', artifactPath: '/logs/ship.log' });
    const state = buildDashboardState(store, t.id);
    expect(state.insideViews.impl.console).toBeFalsy();
    expect(state.insideViews.ship.console).toBeFalsy();
  });

  it('does not flag a gate stage that has no stage row at all', () => {
    const t = createTicket(store, { key: 'PROJ-3', title: 'thing' });
    const state = buildDashboardState(store, t.id);
    expect(state.insideViews.uat.console).toBeFalsy();
    expect(state.insideViews.review.console).toBeFalsy();
  });
});

describe('buildDashboardState — ship header slot', () => {
  let store: Store;
  beforeEach(() => (store = openStore(':memory:')));
  afterEach(() => store.close());

  it('offers confirm when the ticket sits at ship ready', () => {
    const t = createTicket(store, { key: 'SHIP-C', title: 'ship' });
    store.db.prepare("UPDATE tickets SET stage_current = 'ship' WHERE id = ?").run(t.id);
    expect(buildDashboardState(store, t.id).ship).toEqual({ kind: 'confirm' });
  });

  it('reports waiting-merge when ship is parked awaiting merge', () => {
    const t = createTicket(store, { key: 'SHIP-W', title: 'ship' });
    setStage(store, t.id, 'ship', { status: 'passed', startedAt: '2026-08-09T10:00:00.000Z' });
    parkGateStage(store, {
      ticketId: t.id, stageKey: 'ship', kind: 'awaiting-merge',
      reason: 'PR #412 is open and unmerged', runAt: '2026-08-09T10:33:42.000Z', gates: [],
    });
    store.db.prepare("UPDATE tickets SET stage_current = 'ship' WHERE id = ?").run(t.id);
    expect(buildDashboardState(store, t.id).ship.kind).toBe('waiting-merge');
  });

  it('reports retry when ship failed', () => {
    const t = createTicket(store, { key: 'SHIP-F', title: 'ship' });
    setStage(store, t.id, 'ship', { status: 'failed', verdict: 'gh pr create failed' });
    store.db.prepare("UPDATE tickets SET stage_current = 'ship' WHERE id = ?").run(t.id);
    expect(buildDashboardState(store, t.id).ship).toEqual({ kind: 'retry', reason: 'gh pr create failed' });
  });
});

describe('buildDashboardState — send back to implement', () => {
  let store: Store;
  let seq = 0;
  beforeEach(() => {
    store = openStore(':memory:');
    seq = 0;
  });
  afterEach(() => store.close());

  function at(stage: string): number {
    seq += 1;
    const t = createTicket(store, { key: `SB-${seq}`, title: 't' });
    store.db.prepare('UPDATE tickets SET stage_current = ? WHERE id = ?').run(stage, t.id);
    return t.id;
  }

  it('offers the action on a settled uat stage', () => {
    const id = at('uat');
    setStage(store, id, 'uat', { status: 'passed' });
    expect(buildDashboardState(store, id).sendBack).toEqual({ available: true, stage: 'uat' });
  });

  it('offers the action on a settled review stage', () => {
    const id = at('review');
    setStage(store, id, 'review', { status: 'passed' });
    expect(buildDashboardState(store, id).sendBack).toEqual({ available: true, stage: 'review' });
  });

  it('withholds the action at ship once any current PR has merged', () => {
    const id = at('ship');
    store.db
      .prepare("INSERT INTO prs (ticket_id, repo, number, url, status) VALUES (?, 'api', 12, 'u', 'merged')")
      .run(id);
    expect(buildDashboardState(store, id).sendBack).toEqual({ available: false, reason: 'landed' });
  });

  it('offers the action at ship awaiting confirm (no PR yet)', () => {
    const id = at('ship');
    expect(buildDashboardState(store, id).sendBack).toEqual({ available: true, stage: 'ship' });
  });

  it('offers the action at ship while awaiting merge', () => {
    const id = at('ship');
    setStage(store, id, 'ship', { status: 'passed', startedAt: '2026-08-09T10:00:00.000Z' });
    parkGateStage(store, {
      ticketId: id, stageKey: 'ship', kind: 'awaiting-merge',
      reason: 'PR #412 is open and unmerged', runAt: '2026-08-09T10:33:42.000Z', gates: [],
    });
    expect(buildDashboardState(store, id).sendBack).toEqual({ available: true, stage: 'ship' });
  });

  it('withholds the action while the stage is running (in-flight)', () => {
    const id = at('uat');
    setStage(store, id, 'uat', { status: 'running', startedAt: '2026-08-09T10:00:00.000Z' });
    expect(buildDashboardState(store, id).sendBack).toEqual({ available: false, reason: 'in-flight' });
  });

  it('offers the action on a parked (blocked) gate — settled, not running', () => {
    const id = at('uat');
    setStage(store, id, 'uat', { status: 'running', startedAt: '2026-08-09T10:00:00.000Z' });
    parkGateStage(store, {
      ticketId: id, stageKey: 'uat', kind: 'capability-missing',
      reason: 'playwright missing', runAt: '2026-08-09T10:33:42.000Z', gates: [],
    });
    expect(buildDashboardState(store, id).sendBack).toEqual({ available: true, stage: 'uat' });
  });

  it('never offers the action at scope/impl/fix/done', () => {
    for (const stage of ['scope', 'impl', 'fix', 'done'] as const) {
      const id = at(stage);
      expect(buildDashboardState(store, id).sendBack).toEqual({ available: false, reason: 'stage' });
    }
  });
});

describe('buildDashboardState — runnable scope', () => {
  let store: Store;
  beforeEach(() => (store = openStore(':memory:')));

  function scoped(repos: string[]): number {
    const t = createTicket(store, { key: 'P-1', title: 'x' });
    updateTicketFields(store, t.id, { selectedRepos: repos });
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

describe('insideViews (the six-stage inside presentation)', () => {
  let store: Store;
  beforeEach(() => (store = openStore(':memory:')));
  afterEach(() => store.close());

  function ticketAt(stage: string): number {
    const t = createTicket(store, { key: 'IN-1', title: 'inside' });
    store.db.prepare('UPDATE tickets SET stage_current = ? WHERE id = ?').run(stage, t.id);
    return t.id;
  }

  it('has EXACTLY six stages and never a peer Fix stage', () => {
    const ticketId = ticketAt('impl');
    const state = buildDashboardState(store, ticketId);
    expect(Object.keys(state.insideViews).sort()).toEqual(['done', 'impl', 'review', 'scope', 'ship', 'uat']);
    expect((state.insideViews as Record<string, unknown>).fix).toBeUndefined();
  });

  it('projects the runtime fix stage onto the stage it is causally attached to', () => {
    // A ticket parked at fix with an active UAT recovery round presents UAT.
    const ticketId = ticketAt('fix');
    const state = buildDashboardState(store, ticketId);
    expect(state.presentedStage).toBe('uat');
  });

  it('renders the quality stages as process lists with recovery inserted causally', () => {
    const ticketId = ticketAt('uat');
    const views = buildDashboardState(store, ticketId).insideViews;
    expect(views.uat.processes.map((p) => p.id)).toEqual(['gates', 'services', 'tester']);
    expect(views.review.processes.map((p) => p.id)).toEqual(['gates', 'services', 'review']);
  });

  it('renders the resolved gate names as pending rows before the uat stage runs', () => {
    // The wiring the reducer test cannot prove: the panel's cached resolution
    // must reach the uat view's gates process through buildDashboardState.
    const ticketId = ticketAt('uat');
    const state = buildDashboardState(
      store,
      ticketId,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { uat: [{ name: 'test', disabled: false }], review: [] },
    );
    const gates = state.insideViews.uat.processes.find((p) => p.id === 'gates')!;
    const rows = (gates.evidence as { kind: 'gates'; rows: readonly { label: string }[] }).rows;
    expect(rows).toEqual([expect.objectContaining({ label: 'test' })]);
  });

  it('renders ship and done from the same current PR read', () => {
    const ticketId = ticketAt('ship');
    store.db
      .prepare(
        `INSERT INTO prs (ticket_id, repo, number, url, status)
         VALUES (?, 'web', 40, 'https://github.com/o/r/pull/40', 'open')`,
      )
      .run(ticketId);
    const state = buildDashboardState(store, ticketId);
    const shipMerge = state.insideViews.ship.processes.find((p) => p.id === 'merge')!;
    expect(shipMerge.status).toBe('wait');
    // The done receipt stays pending — nothing is merged.
    expect(state.insideViews.done.processes[0]!.status).toBe('wait');
  });

  it('mints opaque actions onto evidence rows only when a registry is supplied', () => {
    const ticketId = ticketAt('uat');
    recordGateRun(store, {
      ticketId,
      stageKey: 'uat',
      attempt: 0,
      runAt: '2026-08-08T10:00:00.000Z',
      gates: [{ gateName: 'test (web)', exitCode: 0 }],
    });
    const plain = buildDashboardState(store, ticketId).insideViews.uat;
    expect(plain.processes.find((p) => p.id === 'gates')!.action).toBeUndefined();
  });

  it('carries the continuation label through the attach seam (B9)', () => {
    // handoff §10: the label ("Show 2 more") is computed by the reducers on
    // the target; the attach seam must carry it beside the minted action,
    // because the registry itself models only {actionId, kind}.
    const ticketId = ticketAt('done');
    const insert = store.db.prepare(
      `INSERT INTO prs (ticket_id, repo, number, url, status, merged_at)
       VALUES (?, ?, ?, ?, 'merged', ?)`,
    );
    for (let i = 0; i < 8; i += 1) {
      insert.run(ticketId, `repo-${i}`, 100 + i, `https://github.com/o/r/pull/${100 + i}`, '2026-08-08T10:00:00.000Z');
    }
    const registry = new InsideActionRegistry(1, ticketId);
    const state = buildDashboardState(store, ticketId, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, registry);
    const receipt = state.insideViews.done.processes.find((p) => p.id === 'delivery-receipt')!;
    // The delivery rows now carry their own `open-pr` action (the PR number is
    // the link), so the continuation is selected by KIND, not by "the first row
    // that has an action".
    const continuation = receipt.evidence?.rows
      .map((r) => r.action)
      .find((a) => a?.kind === 'open-bounded-evidence');
    expect(continuation).toMatchObject({ kind: 'open-bounded-evidence', label: 'Show 2 more' });
  });

  it('states the running process as the stage live line', () => {
    const ticketId = ticketAt('impl');
    setStage(store, ticketId, 'impl', { status: 'running', startedAt: '2026-08-09T10:00:00.000Z' });
    const impl = buildDashboardState(store, ticketId).insideViews.impl;
    expect(impl.live).toMatchObject({ status: 'run', label: 'Session' });
  });

  it('omits the live line for a stage with nothing running or waiting', () => {
    const ticketId = ticketAt('impl');
    setStage(store, ticketId, 'impl', { status: 'passed' });
    expect(buildDashboardState(store, ticketId).insideViews.impl.live).toBeUndefined();
  });
});

describe('buildDashboardState — graph inside projection (Slice-2 T10)', () => {
  let store: Store;
  beforeEach(() => (store = openStore(':memory:')));
  afterEach(() => store.close());

  it('appends graph rows to the impl view only when the host supplies the projection', () => {
    const t = createTicket(store, { key: 'G-1', title: 'graph' });
    store.db.prepare('UPDATE tickets SET stage_current = ? WHERE id = ?').run('impl', t.id);

    const inert = buildDashboardState(store, t.id);
    expect(inert.insideViews.impl.processes.map((p) => p.id)).toEqual(['session']);

    const wired = buildDashboardState(store, t.id, undefined, undefined, () => [], () => true, undefined, {}, () => 1, () => [], () => null, null, undefined, () => false, () => undefined, {
      enabled: true,
      graphRun: { id: 7, status: 'running', approachId: 'karst-graph-engineering', stageAttempt: 0, createdAt: '2026-08-11T00:00:00.000Z' },
      plannerRuns: [],
      nodeRuns: [],
      overrides: [],
      deferrals: [],
      execution: { maxParallel: 1, maxNodeRuns: 40 },
      revision: null,
      diagnostics: [],
      artifacts: [],
      liveSessions: [],
      now: '2026-08-11T01:00:00.000Z',
    });
    const impl = wired.insideViews.impl;
    expect(impl.processes.map((p) => p.id)).toEqual(['session', 'graph']);
    expect(impl.processes[1]!.label).toBe('Implementation graph');
    expect(impl.processes[1]!.status).toBe('run');
  });
});
