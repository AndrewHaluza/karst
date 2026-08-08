import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { openStore, type Store } from '../store/db.js';
import { createTicket, getTicket } from '../store/tickets.js';
import { dispatchHook, parseHookPayload } from './dispatch.js';
import { createHookChannelRecorder } from '../diagnostics/hookChannel.js';
import { recordSessionLaunchIntent } from '../store/sessionLaunchIntents.js';
import { listImplementationTimeline } from '../store/implementationRuns.js';
import { listProcessRuns } from '../store/processRuns.js';
import { openProcessRun } from '../store/processRuns.js';
import { listTokenUsage } from '../store/tokenUsage.js';
import { lastInteractiveUsageSample } from '../store/interactiveUsageSamples.js';

/** Register a worktree row directly so a payload cwd resolves to a ticket. */
function seedWorktree(store: Store, ticketId: number, path: string): void {
  store.db
    .prepare(
      `INSERT INTO worktrees (ticket_id, repo, path, branch, base_ref, deps_mode)
       VALUES (?, 'app', ?, 'karst/x', 'main', 'inherited')`,
    )
    .run(ticketId, path);
}

describe('dispatchHook', () => {
  let store: Store;
  const WT = '/repo/.karst/worktrees/x';
  beforeEach(() => (store = openStore(':memory:')));
  afterEach(() => store.close());

  function ticketAt(): number {
    const t = createTicket(store, { key: 'A', title: 'a' });
    seedWorktree(store, t.id, WT);
    return t.id;
  }

  it('SessionStart flips agent_state to running for the ticket at cwd', () => {
    const id = ticketAt();
    dispatchHook(store, { hook_event_name: 'SessionStart', cwd: WT });
    expect(getTicket(store, id).agentState).toBe('running');
  });

  it('records why a delivered hook changed nothing', () => {
    // "The hook fired and the board did not move" has four distinct causes; the
    // report has to name which one, not just that a request arrived.
    const recorder = createHookChannelRecorder();
    ticketAt();
    dispatchHook(store, { hook_event_name: 'Stop', cwd: WT }, undefined, undefined, undefined, recorder);
    dispatchHook(store, { hook_event_name: 'Stop', cwd: '/elsewhere' }, undefined, undefined, undefined, recorder);
    dispatchHook(store, { hook_event_name: 'Stop' }, undefined, undefined, undefined, recorder);
    dispatchHook(store, { hook_event_name: 'PreToolUse', cwd: WT }, undefined, undefined, undefined, recorder);
    dispatchHook(store, { hook_event_name: 'Stop', cwd: WT }, undefined, () => false, undefined, recorder);
    expect(recorder.snapshot().outcomes).toEqual({
      applied: 1,
      'unknown-worktree': 2,
      'no-signal': 1,
      'stale-generation': 1,
    });
  });

  it('SessionEnd flips agent_state to idle', () => {
    const id = ticketAt();
    dispatchHook(store, { hook_event_name: 'SessionStart', cwd: WT });
    dispatchHook(store, { hook_event_name: 'SessionEnd', cwd: WT });
    expect(getTicket(store, id).agentState).toBe('idle');
  });

  it('a lifecycle barrier can reject a stale SessionEnd after replacement SessionStart', () => {
    const id = ticketAt();
    dispatchHook(store, { hook_event_name: 'SessionStart', cwd: WT });
    dispatchHook(
      store,
      { hook_event_name: 'SessionEnd', cwd: WT },
      undefined,
      () => false,
    );
    expect(getTicket(store, id).agentState).toBe('running');
  });

  it('rejects a stale SessionStart before it can overwrite the current session id', () => {
    const id = ticketAt();
    dispatchHook(
      store,
      { hook_event_name: 'SessionStart', cwd: WT, session_id: 'current-session' },
      undefined,
      () => true,
    );
    dispatchHook(
      store,
      { hook_event_name: 'SessionStart', cwd: WT, session_id: 'stale-session' },
      undefined,
      () => false,
    );

    const ticket = getTicket(store, id);
    expect(ticket.sessionId).toBe('current-session');
    expect(ticket.agentState).toBe('running');
  });

  it('Notification (idle_prompt) flips agent_state to waiting (amber)', () => {
    const id = ticketAt();
    dispatchHook(store, {
      hook_event_name: 'Notification',
      cwd: WT,
      message: 'idle_prompt',
    });
    expect(getTicket(store, id).agentState).toBe('waiting');
  });

  it('Notification (permission_prompt) also flips to waiting', () => {
    const id = ticketAt();
    dispatchHook(store, {
      hook_event_name: 'Notification',
      cwd: WT,
      message: 'permission_prompt',
    });
    expect(getTicket(store, id).agentState).toBe('waiting');
  });

  // Real Claude Code payloads carry the symbolic kind in `notification_type`;
  // `message` is free-text ("Claude needs your permission to use Bash"). The
  // amber signal must key off `notification_type`, or a real permission prompt
  // (e.g. non-statically-analyzable Bash) never surfaces "Needs you".
  it('Notification with notification_type permission_prompt + free-text message → waiting', () => {
    const id = ticketAt();
    dispatchHook(store, {
      hook_event_name: 'Notification',
      cwd: WT,
      notification_type: 'permission_prompt',
      message: 'Claude needs your permission to use Bash',
    });
    expect(getTicket(store, id).agentState).toBe('waiting');
  });

  it('Notification with notification_type idle_prompt → waiting', () => {
    const id = ticketAt();
    dispatchHook(store, {
      hook_event_name: 'Notification',
      cwd: WT,
      notification_type: 'idle_prompt',
      message: 'Claude is waiting for your input',
    });
    expect(getTicket(store, id).agentState).toBe('waiting');
  });

  it('Notification with notification_type agent_needs_input → waiting', () => {
    const id = ticketAt();
    dispatchHook(store, {
      hook_event_name: 'Notification',
      cwd: WT,
      notification_type: 'agent_needs_input',
      message: 'Agent is waiting for your input',
    });
    expect(getTicket(store, id).agentState).toBe('waiting');
  });

  it('Notification with a non-input notification_type (auth_success) does not flip to waiting', () => {
    const id = ticketAt();
    dispatchHook(store, { hook_event_name: 'SessionStart', cwd: WT });
    dispatchHook(store, {
      hook_event_name: 'Notification',
      cwd: WT,
      notification_type: 'auth_success',
      message: 'Logged in',
    });
    expect(getTicket(store, id).agentState).toBe('running');
  });

  it('UserPromptSubmit flips a waiting agent back to running', () => {
    const id = ticketAt();
    dispatchHook(store, {
      hook_event_name: 'Notification',
      cwd: WT,
      message: 'permission_prompt',
    });
    dispatchHook(store, { hook_event_name: 'UserPromptSubmit', cwd: WT });
    expect(getTicket(store, id).agentState).toBe('running');
  });

  it('PostToolUse flips a waiting agent back to running', () => {
    const id = ticketAt();
    dispatchHook(store, {
      hook_event_name: 'Notification',
      cwd: WT,
      message: 'permission_prompt',
    });
    dispatchHook(store, { hook_event_name: 'PostToolUse', cwd: WT });
    expect(getTicket(store, id).agentState).toBe('running');
  });

  it('Stop never infers a stage transition — stage_current is untouched', () => {
    const id = ticketAt();
    const before = getTicket(store, id).stageCurrent;
    dispatchHook(store, { hook_event_name: 'Stop', cwd: WT });
    expect(getTicket(store, id).stageCurrent).toBe(before);
  });

  it('treats opencode session.idle as Stop and permission.asked as waiting', () => {
    const id = ticketAt();
    dispatchHook(store, { hook_event_name: 'session.idle', cwd: WT, session_id: 'ses_1' });
    // Stop semantics: the session finished a turn
    expect(getTicket(store, id).agentState).toBe('idle');
    dispatchHook(store, { hook_event_name: 'permission.asked', cwd: WT, session_id: 'ses_1' });
    expect(getTicket(store, id).agentState).toBe('waiting');
  });

  it('treats an unknown opencode event (session.error) as no-signal', () => {
    const id = ticketAt();
    dispatchHook(store, {
      hook_event_name: 'session.error',
      cwd: WT,
      session_id: 'ses_1',
      message: 'boom',
    });
    expect(getTicket(store, id).agentState).toBe('none');
  });

  it('an unknown cwd is ignored (no throw, no mutation)', () => {
    const id = ticketAt();
    expect(() =>
      dispatchHook(store, { hook_event_name: 'SessionStart', cwd: '/nope' }),
    ).not.toThrow();
    expect(getTicket(store, id).agentState).toBe('none');
  });

  it('fans out to the notify callback with the affected ticket id', () => {
    const id = ticketAt();
    const notify = vi.fn();
    const payload = { hook_event_name: 'SessionStart', cwd: WT };
    dispatchHook(store, payload, notify);
    expect(notify).toHaveBeenCalledWith(id, payload);
  });

  it('does not call notify when nothing matched', () => {
    ticketAt();
    const notify = vi.fn();
    dispatchHook(store, { hook_event_name: 'SessionStart', cwd: '/nope' }, notify);
    expect(notify).not.toHaveBeenCalled();
  });

  it('persists session_id on SessionStart and sets agent_state running', () => {
    const id = ticketAt();
    dispatchHook(store, { hook_event_name: 'SessionStart', cwd: WT, session_id: 'sess-xyz' });
    const t = getTicket(store, id);
    expect(t.sessionId).toBe('sess-xyz');
    expect(t.agentState).toBe('running');
  });

  it('does not touch session_id on a Stop event', () => {
    const id = ticketAt();
    dispatchHook(store, { hook_event_name: 'SessionStart', cwd: WT, session_id: 'sess-1' });
    dispatchHook(store, { hook_event_name: 'Stop', cwd: WT, session_id: 'sess-DIFFERENT' });
    expect(getTicket(store, id).sessionId).toBe('sess-1');
  });

  // A session id only resolves for the agent CLI that minted it, so the capture
  // must record which core was running — otherwise a later provider switch
  // hands the new CLI a foreign id and `--resume` dies on launch.
  it('tags a captured session with the provider resolved for that ticket', () => {
    const id = ticketAt();
    dispatchHook(
      store,
      { hook_event_name: 'SessionStart', cwd: WT, session_id: 'sess-xyz' },
      undefined,
      undefined,
      () => 'codex',
    );
    const t = getTicket(store, id);
    expect(t.sessionId).toBe('sess-xyz');
    expect(t.sessionProvider).toBe('codex');
  });

  it('leaves a capture untagged when no provider resolver is supplied', () => {
    const id = ticketAt();
    dispatchHook(store, { hook_event_name: 'SessionStart', cwd: WT, session_id: 'sess-xyz' });
    expect(getTicket(store, id).sessionProvider).toBeNull();
  });

  it('SessionStart with a matching launch id confirms the pending intent and its segment', () => {
    const id = ticketAt();
    recordSessionLaunchIntent(store, {
      ticketId: id, launchId: 'launch-1', purpose: 'implementation',
      provider: 'claude', model: 'opus', reason: 'initial', sessionOrigin: 'new',
      at: '2026-08-01T10:00:00.000Z',
    });
    dispatchHook(
      store,
      { hook_event_name: 'SessionStart', cwd: WT, session_id: 'sess-1', launchId: 'launch-1' },
      undefined,
      () => true,
      () => 'claude',
    );
    const timeline = listImplementationTimeline(store, id)!;
    expect(timeline.segments).toHaveLength(1);
    expect(timeline.segments[0]!.providerSessionId).toBe('sess-1');
    expect(timeline.segments[0]!.status).toBe('running');
    expect(timeline.segments[0]!.provider).toBe('claude');
    expect(getTicket(store, id).sessionId).toBe('sess-1');
  });

  it('SessionStart with an unknown launch id creates no segment', () => {
    const id = ticketAt();
    dispatchHook(
      store,
      { hook_event_name: 'SessionStart', cwd: WT, session_id: 'sess-1', launchId: 'never-recorded' },
      undefined,
      () => true,
      () => 'claude',
    );
    expect(listImplementationTimeline(store, id)).toBeNull();
    // The ordinary session liveness signal still lands.
    expect(getTicket(store, id).agentState).toBe('running');
  });

  it('a SessionStart whose provider no longer matches the ticket is rejected', () => {
    const id = ticketAt();
    recordSessionLaunchIntent(store, {
      ticketId: id, launchId: 'launch-1', purpose: 'implementation',
      provider: 'claude', model: 'opus', reason: 'initial', sessionOrigin: 'new',
      at: '2026-08-01T10:00:00.000Z',
    });
    dispatchHook(
      store,
      { hook_event_name: 'SessionStart', cwd: WT, session_id: 'sess-1', launchId: 'launch-1' },
      undefined,
      () => true,
      () => 'codex',
    );
    // The run is open (the launch was prepared) but no segment was confirmed:
    // the mismatched start attached nothing.
    expect(listImplementationTimeline(store, id)!.segments).toHaveLength(0);
  });

  it('SessionEnd without the marker interrupts the segment and process run, never passing the run', () => {
    const id = ticketAt();
    recordSessionLaunchIntent(store, {
      ticketId: id, launchId: 'launch-1', purpose: 'implementation',
      provider: 'claude', model: 'opus', reason: 'initial', sessionOrigin: 'new',
      at: '2026-08-01T10:00:00.000Z',
    });
    dispatchHook(
      store,
      { hook_event_name: 'SessionStart', cwd: WT, session_id: 'sess-1', launchId: 'launch-1' },
      undefined,
      () => true,
      () => 'claude',
    );
    dispatchHook(
      store,
      { hook_event_name: 'SessionEnd', cwd: WT, session_id: 'sess-1', launchId: 'launch-1' },
      undefined,
      () => true,
      () => 'claude',
    );

    const timeline = listImplementationTimeline(store, id)!;
    expect(timeline.run.status).toBe('interrupted');
    expect(timeline.segments[0]!.status).toBe('interrupted');
    expect(listProcessRuns(store, id)[0]!.status).toBe('interrupted');
    expect(timeline.run.status).not.toBe('passed');
    expect(getTicket(store, id).agentState).toBe('idle');
  });

  it('SessionEnd for a ticket with no implementation run is a no-op', () => {
    const id = ticketAt();
    expect(() =>
      dispatchHook(store, { hook_event_name: 'SessionEnd', cwd: WT }),
    ).not.toThrow();
    expect(getTicket(store, id).agentState).toBe('idle');
  });

  it('SessionEnd never undoes a run the marker already passed', () => {
    const id = ticketAt();
    recordSessionLaunchIntent(store, {
      ticketId: id, launchId: 'launch-1', purpose: 'implementation',
      provider: 'claude', model: 'opus', reason: 'initial', sessionOrigin: 'new',
      at: '2026-08-01T10:00:00.000Z',
    });
    dispatchHook(
      store,
      { hook_event_name: 'SessionStart', cwd: WT, session_id: 'sess-1', launchId: 'launch-1' },
      undefined,
      () => true,
      () => 'claude',
    );
    const timeline = listImplementationTimeline(store, id)!;
    // The marker (the only completion authority) passed the run.
    store.db
      .prepare("UPDATE implementation_runs SET status = 'passed', ended_at = ? WHERE id = ?")
      .run('2026-08-01T11:00:00.000Z', timeline.run.id);

    dispatchHook(
      store,
      { hook_event_name: 'SessionEnd', cwd: WT, session_id: 'sess-1', launchId: 'launch-1' },
      undefined,
      () => true,
      () => 'claude',
    );

    const after = listImplementationTimeline(store, id)!;
    expect(after.run.status).toBe('passed');
    expect(after.run.endedAt).toBe('2026-08-01T11:00:00.000Z');
  });
});

/**
 * The closed UsageUpdate event (Task 5): a provider bridge posts measured
 * cumulative token counts for an interactive session, and the dispatch records
 * the delta against the session's last persisted observation, attributed to the
 * currently bound process. Usage is not a liveness signal — agent_state never
 * changes — and a malformed or unattributable update reaches no table.
 */
describe('dispatchHook — UsageUpdate', () => {
  let store: Store;
  const WT = '/repo/.karst/worktrees/x';
  beforeEach(() => (store = openStore(':memory:')));
  afterEach(() => store.close());

  function ticketAt(provider = 'claude'): number {
    const t = createTicket(store, { key: 'U', title: 'usage' });
    seedWorktree(store, t.id, WT);
    return t.id;
  }

  function startImplementation(id: number, sessionId: string, launchId = 'launch-u'): void {
    recordSessionLaunchIntent(store, {
      ticketId: id, launchId, purpose: 'implementation',
      provider: 'claude', model: 'opus', reason: 'initial', sessionOrigin: 'new',
      at: '2026-08-01T10:00:00.000Z',
    });
    dispatchHook(
      store,
      { hook_event_name: 'SessionStart', cwd: WT, session_id: sessionId, launchId },
      undefined,
      () => true,
      () => 'claude',
    );
  }

  function usageUpdate(sessionId: string, usage: unknown, launchId?: string): void {
    dispatchHook(
      store,
      {
        hook_event_name: 'UsageUpdate',
        cwd: WT,
        session_id: sessionId,
        usage,
        ...(launchId !== undefined ? { launchId } : {}),
      },
      undefined,
      () => true,
      () => 'claude',
    );
  }

  it('records a measured delta against the confirmed session, attributed to the Session process', () => {
    const id = ticketAt();
    startImplementation(id, 'sess-1');
    usageUpdate('sess-1', { event_id: 'e1', input: 1_000, output: 200 });
    usageUpdate('sess-1', { event_id: 'e2', input: 1_450, output: 320, cache_read: 180, cache_write: 40, total: 1_990 });

    const entries = listTokenUsage(store, { ticketId: id });
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ callSite: 'implementation', inputTokens: 1_000, outputTokens: 200 });
    // e1 carried no cache counts: its derived total is 1_200, so the delta
    // total against e2's provider-reported 1_990 is 790.
    expect(entries[1]).toMatchObject({
      callSite: 'implementation',
      inputTokens: 450,
      outputTokens: 120,
      cacheReadTokens: 180,
      cacheWriteTokens: 40,
      totalTokens: 790,
    });
    // Usage is not a liveness signal.
    expect(getTicket(store, id).agentState).toBe('running'); // still the SessionStart state
  });

  it('attributes a fix session’s updates to the fix process run with call_site fix-resume', () => {
    const id = ticketAt();
    startImplementation(id, 'sess-1');
    usageUpdate('sess-1', { event_id: 'e1', input: 1_000, output: 200 });
    // The implementation completes; a Fix process resumes the same provider session.
    store.db
      .prepare('UPDATE implementation_runs SET status = ? WHERE ticket_id = ?')
      .run('passed', id);
    const fixRun = openProcessRun(store, {
      ticketId: id, stageKey: 'fix', processId: 'session', attempt: 1,
      startedAt: '2026-08-01T12:00:00.000Z',
    });
    recordSessionLaunchIntent(store, {
      ticketId: id, launchId: 'launch-fix', purpose: 'fix',
      provider: 'claude', model: 'opus', reason: 'resume', sessionOrigin: 'resume',
      at: '2026-08-01T12:01:00.000Z',
    });
    dispatchHook(
      store,
      { hook_event_name: 'SessionStart', cwd: WT, session_id: 'sess-1', launchId: 'launch-fix' },
      undefined,
      () => true,
      () => 'claude',
    );
    usageUpdate('sess-1', { event_id: 'e2', input: 1_700, output: 340 });

    const fixEntry = listTokenUsage(store, { ticketId: id, processRunId: fixRun.id });
    expect(fixEntry).toHaveLength(1);
    expect(fixEntry[0]).toMatchObject({
      callSite: 'fix-resume',
      processRunId: fixRun.id,
      inputTokens: 700,
      outputTokens: 140,
      totalTokens: 840,
    });
  });

  it('baselines a resumed session with no prior sample — nothing reaches the ledger', () => {
    const id = ticketAt();
    recordSessionLaunchIntent(store, {
      ticketId: id, launchId: 'launch-r', purpose: 'implementation',
      provider: 'claude', model: 'opus', reason: 'resume', sessionOrigin: 'resume',
      at: '2026-08-01T10:00:00.000Z',
    });
    dispatchHook(
      store,
      { hook_event_name: 'SessionStart', cwd: WT, session_id: 'sess-1', launchId: 'launch-r' },
      undefined,
      () => true,
      () => 'claude',
    );
    usageUpdate('sess-1', { event_id: 'e1', input: 5_000, output: 400 });

    expect(listTokenUsage(store, { ticketId: id })).toHaveLength(0);
    const baseline = lastInteractiveUsageSample(store, 'claude', 'sess-1')!;
    expect(baseline.baselineOnly).toBe(true);
  });

  it('drops malformed or partial usage before it reaches the store', () => {
    const id = ticketAt();
    startImplementation(id, 'sess-1');
    usageUpdate('sess-1', { event_id: 'e1', input: 'not-a-number', output: 200 });
    usageUpdate('sess-1', { input: 1_000, output: 200 }); // no event id
    usageUpdate('sess-1', { event_id: 'e3', input: -5, output: 200 });
    usageUpdate('sess-1', 'usage');

    expect(listTokenUsage(store, { ticketId: id })).toHaveLength(0);
    expect(store.db.prepare('SELECT COUNT(*) AS n FROM interactive_usage_samples').get()).toEqual({
      n: 0,
    });
  });

  it('drops an update for a session with no confirmed binding', () => {
    const id = ticketAt();
    // No SessionStart ever confirmed an intent for sess-1.
    usageUpdate('sess-1', { event_id: 'e1', input: 100, output: 20 });
    expect(listTokenUsage(store, { ticketId: id })).toHaveLength(0);
    expect(store.db.prepare('SELECT COUNT(*) AS n FROM interactive_usage_samples').get()).toEqual({
      n: 0,
    });
  });

  it('a stale generation barrier rejects a UsageUpdate from a superseded launch', () => {
    const id = ticketAt();
    startImplementation(id, 'sess-1');
    dispatchHook(
      store,
      { hook_event_name: 'UsageUpdate', cwd: WT, session_id: 'sess-1', usage: { event_id: 'e1', input: 100, output: 20 } },
      undefined,
      () => false, // the lifecycle barrier refuses this generation
      () => 'claude',
    );
    expect(listTokenUsage(store, { ticketId: id })).toHaveLength(0);
    expect(store.db.prepare('SELECT COUNT(*) AS n FROM interactive_usage_samples').get()).toEqual({
      n: 0,
    });
  });

  it('an unknown cwd or missing session id is ignored', () => {
    ticketAt();
    dispatchHook(store, {
      hook_event_name: 'UsageUpdate',
      cwd: '/elsewhere',
      session_id: 'sess-1',
      usage: { event_id: 'e1', input: 100, output: 20 },
    });
    dispatchHook(store, {
      hook_event_name: 'UsageUpdate',
      cwd: WT,
      usage: { event_id: 'e1', input: 100, output: 20 },
    });
    expect(store.db.prepare('SELECT COUNT(*) AS n FROM interactive_usage_samples').get()).toEqual({
      n: 0,
    });
  });
});

describe('parseHookPayload', () => {
  it('accepts a well-formed payload of optional strings', () => {
    expect(
      parseHookPayload({
        hook_event_name: 'Notification',
        cwd: '/wt',
        session_id: 's',
        message: 'm',
        notification_type: 'permission_prompt',
      }),
    ).toEqual({
      hook_event_name: 'Notification',
      cwd: '/wt',
      session_id: 's',
      message: 'm',
      notification_type: 'permission_prompt',
    });
  });

  it('accepts an empty object (all fields optional)', () => {
    expect(parseHookPayload({})).toEqual({
      hook_event_name: undefined,
      cwd: undefined,
      session_id: undefined,
      message: undefined,
      notification_type: undefined,
    });
  });

  it('rejects a non-string notification_type', () => {
    expect(parseHookPayload({ notification_type: 123 })).toBeNull();
  });

  it('rejects a non-object (null / array / primitive)', () => {
    expect(parseHookPayload(null)).toBeNull();
    expect(parseHookPayload([])).toBeNull();
    expect(parseHookPayload('Stop')).toBeNull();
  });

  it('rejects a non-string cwd — would otherwise throw at the SQL bind', () => {
    expect(parseHookPayload({ cwd: 123 })).toBeNull();
    expect(parseHookPayload({ cwd: {} })).toBeNull();
    expect(parseHookPayload({ hook_event_name: ['Stop'] })).toBeNull();
  });

  it('accepts a UsageUpdate payload carrying an unvalidated usage object', () => {
    const parsed = parseHookPayload({
      hook_event_name: 'UsageUpdate',
      cwd: '/wt',
      session_id: 's',
      usage: { event_id: 'e1', input: 100, output: 20, cache_read: 0, total: 120 },
    });
    expect(parsed?.hook_event_name).toBe('UsageUpdate');
    expect(parsed?.usage).toEqual({ event_id: 'e1', input: 100, output: 20, cache_read: 0, total: 120 });
  });

  it('rejects a non-object usage at the boundary', () => {
    expect(parseHookPayload({ hook_event_name: 'UsageUpdate', cwd: '/wt', usage: 7 })).toBeNull();
    expect(parseHookPayload({ hook_event_name: 'UsageUpdate', cwd: '/wt', usage: [1] })).toBeNull();
  });
});
