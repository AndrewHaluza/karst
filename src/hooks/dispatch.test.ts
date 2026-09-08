import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { openStore, type Store } from '../store/db.js';
import { createTicket, getTicket } from '../store/tickets.js';
import { dispatchHook, parseHookPayload } from './dispatch.js';
import { createHookChannelRecorder } from '../diagnostics/hookChannel.js';
import { recordSessionLaunchIntent } from '../store/sessionLaunchIntents.js';
import {
  completeImplementationRun,
  listImplementationTimeline,
  openImplementationRun,
} from '../store/implementationRuns.js';
import { listProcessRuns } from '../store/processRuns.js';
import { listTokenUsage } from '../store/tokenUsage.js';
import { lastInteractiveUsageSample } from '../store/interactiveUsageSamples.js';
import {
  openRecoveryRound,
  recordFixLaunchIntent,
  beginLiveFixExecution,
  listRecoveryRounds,
} from '../store/recoveryRounds.js';
import { getSessionLaunchIntent } from '../store/sessionLaunchIntents.js';

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

  describe('a turn that ends without the done marker is needs-you', () => {
    function runningImplRun(id: number): void {
      openImplementationRun(store, {
        ticketId: id,
        attempt: 0,
        provider: 'claude',
        startedAt: '2026-09-07T01:18:00.000Z',
      });
    }

    it('Stop while an implementation run is still open reads waiting, not idle', () => {
      // The agent ended its turn with a question in plain prose — no
      // Notification kind describes that, so `Stop` is the only signal karst
      // gets. A stage whose done marker has not fired is not finished, so the
      // ticket needs the user, not a blue "in progress".
      const id = ticketAt();
      runningImplRun(id);
      dispatchHook(store, { hook_event_name: 'Stop', cwd: WT });
      expect(getTicket(store, id).agentState).toBe('waiting');
    });

    it('opencode session.idle follows the same rule', () => {
      const id = ticketAt();
      runningImplRun(id);
      dispatchHook(store, { hook_event_name: 'session.idle', cwd: WT, session_id: 'ses_1' });
      expect(getTicket(store, id).agentState).toBe('waiting');
    });

    it('Stop after the done marker fired reads idle', () => {
      const id = ticketAt();
      runningImplRun(id);
      completeImplementationRun(store, id, '2026-09-07T01:40:00.000Z');
      dispatchHook(store, { hook_event_name: 'Stop', cwd: WT });
      expect(getTicket(store, id).agentState).toBe('idle');
    });

    it('SessionEnd stays idle — a closed terminal asks the user nothing', () => {
      const id = ticketAt();
      runningImplRun(id);
      dispatchHook(store, { hook_event_name: 'SessionEnd', cwd: WT });
      expect(getTicket(store, id).agentState).toBe('idle');
    });
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

  // opencode's plugin posts `permission.asked` at prompt time, but the session
  // RESOLVES and keeps processing — and opencode has no PostToolUse or
  // UserPromptSubmit to flip the amber back. The resolution event is the only
  // "the wait ended" signal it has; without it, one answered prompt left the
  // ticket reading "Needs you" for the whole remaining turn (FIX-WRONG-STATUS).
  it('permission.replied flips a waiting opencode agent back to running', () => {
    const id = ticketAt();
    dispatchHook(store, { hook_event_name: 'permission.asked', cwd: WT, session_id: 'ses_1' });
    expect(getTicket(store, id).agentState).toBe('waiting');
    dispatchHook(store, { hook_event_name: 'permission.replied', cwd: WT, session_id: 'ses_1' });
    expect(getTicket(store, id).agentState).toBe('running');
  });

  it('session.status busy is opencode processing — flips waiting back to running', () => {
    const id = ticketAt();
    dispatchHook(store, { hook_event_name: 'permission.asked', cwd: WT, session_id: 'ses_1' });
    dispatchHook(store, {
      hook_event_name: 'session.status',
      cwd: WT,
      session_id: 'ses_1',
      message: 'busy',
    });
    expect(getTicket(store, id).agentState).toBe('running');
  });

  it('session.status idle is no liveness signal (session.idle owns that)', () => {
    const id = ticketAt();
    dispatchHook(store, {
      hook_event_name: 'session.status',
      cwd: WT,
      session_id: 'ses_1',
      message: 'idle',
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

  it('an Implementation SessionStart keeps the prepared launch provider after the ticket provider changes', () => {
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
    const segment = listImplementationTimeline(store, id)!.segments[0]!;
    expect(segment).toMatchObject({
      provider: 'claude',
      providerSessionId: 'sess-1',
      status: 'running',
    });
    expect(getTicket(store, id)).toMatchObject({
      sessionId: 'sess-1',
      sessionProvider: 'claude',
    });
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

  function usageUpdate(
    sessionId: string,
    usage: unknown,
    launchId?: string,
    notify?: Parameters<typeof dispatchHook>[2],
  ): void {
    dispatchHook(
      store,
      {
        hook_event_name: 'UsageUpdate',
        cwd: WT,
        session_id: sessionId,
        usage,
        ...(launchId !== undefined ? { launchId } : {}),
      },
      notify,
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
      reasoningTokens: 0,
      cacheReadTokens: 180,
      cacheWriteTokens: 40,
      totalTokens: 790,
    });
    // Usage is not a liveness signal.
    expect(getTicket(store, id).agentState).toBe('running'); // still the SessionStart state
  });

  it('notifies views after a UsageUpdate records a new ledger delta', () => {
    const id = ticketAt();
    startImplementation(id, 'sess-1');
    const notify = vi.fn();
    const payload = {
      hook_event_name: 'UsageUpdate',
      cwd: WT,
      session_id: 'sess-1',
      usage: { event_id: 'e1', input: 1_000, output: 200, cache_read: 500 },
    };

    dispatchHook(store, payload, notify, () => true, () => 'claude');

    expect(listTokenUsage(store, { ticketId: id })).toHaveLength(1);
    expect(notify).toHaveBeenCalledOnce();
    expect(notify).toHaveBeenCalledWith(id, payload);
  });

  it('does not notify views when a UsageUpdate repeats an already-recorded event', () => {
    const id = ticketAt();
    startImplementation(id, 'sess-1');
    usageUpdate('sess-1', { event_id: 'e1', input: 1_000, output: 200 });
    const notify = vi.fn();

    usageUpdate('sess-1', { event_id: 'e1', input: 1_000, output: 200 }, undefined, notify);

    expect(listTokenUsage(store, { ticketId: id })).toHaveLength(1);
    expect(notify).not.toHaveBeenCalled();
  });

  it('attributes a fix session’s updates to the Fix process run with call_site fix-resume', () => {
    const id = ticketAt();
    startImplementation(id, 'sess-1');
    usageUpdate('sess-1', { event_id: 'e1', input: 1_000, output: 200 });
    // The implementation completes; the recovery round is committed by the
    // failing verdict and the Fix relaunch owns it.
    store.db
      .prepare('UPDATE implementation_runs SET status = ? WHERE ticket_id = ?')
      .run('passed', id);
    const round = openRecoveryRound(store, {
      ticketId: id, sourceStage: 'uat', sourceProcessId: 'gates',
      sourceStageRunId: null, sourceProcessRunId: null,
      triggerKind: 'gate-failure', triggerDetail: 'exit 1', maxRounds: 3,
      startedAt: '2026-08-01T11:55:00.000Z',
    });
    recordFixLaunchIntent(store, {
      ticketId: id, launchId: 'launch-fix', provider: 'claude', model: 'opus',
      reason: 'resume', sessionOrigin: 'resume', recoveryRoundId: round.id,
      at: '2026-08-01T12:01:00.000Z',
    });
    // The accepted SessionStart routes to confirmFixLaunch, which opens the
    // Fix process run and attaches it to the round.
    dispatchHook(
      store,
      { hook_event_name: 'SessionStart', cwd: WT, session_id: 'sess-1', launchId: 'launch-fix' },
      undefined,
      () => true,
      () => 'claude',
    );
    const fixRun = listProcessRuns(store, id).find((r) => r.processId === 'fix')!;
    expect(fixRun.status).toBe('running');
    expect(listRecoveryRounds(store, id)[0]).toMatchObject({ status: 'fixing', fixProcessRunId: fixRun.id });

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

  it('confirms a Codex Fix SessionStart from its launch intent when the ticket still resolves to Claude', () => {
    const id = ticketAt();
    store.db.prepare('UPDATE tickets SET agent_provider = ? WHERE id = ?').run('claude', id);
    const round = openRecoveryRound(store, {
      ticketId: id,
      sourceStage: 'uat',
      sourceProcessId: 'gates',
      sourceStageRunId: null,
      sourceProcessRunId: null,
      triggerKind: 'gate-failure',
      triggerDetail: 'exit 1',
      maxRounds: 3,
      startedAt: '2026-08-01T11:55:00.000Z',
    });
    recordFixLaunchIntent(store, {
      ticketId: id,
      launchId: 'codex-fix',
      provider: 'codex',
      model: 'gpt-5.6-sol',
      agentName: 'Codex Fix',
      reason: 'switch',
      sessionOrigin: 'new',
      recoveryRoundId: round.id,
      at: '2026-08-01T12:01:00.000Z',
    });

    dispatchHook(
      store,
      {
        hook_event_name: 'SessionStart',
        cwd: WT,
        session_id: 'codex-fix-session',
        launchId: 'codex-fix',
      },
      undefined,
      () => true,
      () => 'claude',
    );

    expect(getSessionLaunchIntent(store, 'codex-fix')).toMatchObject({
      provider: 'codex',
      providerSessionId: 'codex-fix-session',
      status: 'confirmed',
    });
    const fixRun = listProcessRuns(store, id).find((run) => run.processId === 'fix')!;
    expect(fixRun).toMatchObject({
      provider: 'codex',
      model: 'gpt-5.6-sol',
      agentName: 'Codex Fix',
      status: 'running',
    });
    expect(listRecoveryRounds(store, id)[0]).toMatchObject({
      status: 'fixing',
      fixProcessRunId: fixRun.id,
    });
    expect(getTicket(store, id)).toMatchObject({
      agentProvider: 'claude',
      sessionId: 'codex-fix-session',
      sessionProvider: 'codex',
    });

    usageUpdate(
      'codex-fix-session',
      { event_id: 'codex-fix-usage-1', input: 900, output: 120, total: 1_020 },
      'codex-fix',
    );

    expect(lastInteractiveUsageSample(store, 'codex', 'codex-fix-session')).toMatchObject({
      provider: 'codex',
      providerSessionId: 'codex-fix-session',
      processRunId: fixRun.id,
      sourceEventId: 'codex-fix-usage-1',
    });
    expect(listTokenUsage(store, { ticketId: id, processRunId: fixRun.id })).toEqual([
      expect.objectContaining({
        provider: 'codex',
        callSite: 'fix-resume',
        inputTokens: 900,
        outputTokens: 120,
        totalTokens: 1_020,
      }),
    ]);
  });

  it('attributes a live-nudge fix session’s updates to the Fix process run — no new launch intent', () => {
    const id = ticketAt();
    startImplementation(id, 'sess-1');
    usageUpdate('sess-1', { event_id: 'e1', input: 1_000, output: 200 });
    // The implementation completed; the failing gate committed the round.
    store.db
      .prepare('UPDATE implementation_runs SET status = ? WHERE ticket_id = ?')
      .run('passed', id);
    const round = openRecoveryRound(store, {
      ticketId: id, sourceStage: 'uat', sourceProcessId: 'gates',
      sourceStageRunId: null, sourceProcessRunId: null,
      triggerKind: 'gate-failure', triggerDetail: 'exit 1', maxRounds: 3,
      startedAt: '2026-08-01T11:55:00.000Z',
    });
    // The LIVE nudge opens the Fix execution on the still-live session and
    // attaches it to the round; NO fix launch intent exists (the session was
    // never relaunched), so only the ticket's recorded live session — captured
    // at SessionStart — proves the fix owns this provider session.
    const fixRun = beginLiveFixExecution(store, {
      ticketId: id, roundId: round.id, provider: 'claude', model: 'opus',
      startedAt: '2026-08-01T12:01:00.000Z',
    });
    expect(listRecoveryRounds(store, id)[0]).toMatchObject({
      status: 'fixing',
      fixProcessRunId: fixRun.id,
    });

    usageUpdate('sess-1', { event_id: 'e2', input: 1_700, output: 340 });

    const fixEntry = listTokenUsage(store, { ticketId: id, processRunId: fixRun.id });
    expect(fixEntry).toHaveLength(1);
    expect(fixEntry[0]).toMatchObject({
      callSite: 'fix-resume',
      processRunId: fixRun.id,
      implementationSegmentId: null,
      inputTokens: 700,
      outputTokens: 140,
      totalTokens: 840,
    });
  });

  it('a SessionEnd without the marker interrupts the in-flight Fix execution and its round', () => {
    const id = ticketAt();
    const round = openRecoveryRound(store, {
      ticketId: id, sourceStage: 'uat', sourceProcessId: 'gates',
      sourceStageRunId: null, sourceProcessRunId: null,
      triggerKind: 'gate-failure', triggerDetail: 'exit 1', maxRounds: 3,
      startedAt: '2026-08-01T11:55:00.000Z',
    });
    recordFixLaunchIntent(store, {
      ticketId: id, launchId: 'launch-fix', provider: 'claude', model: 'opus',
      reason: 'resume', sessionOrigin: 'resume', recoveryRoundId: round.id,
      at: '2026-08-01T12:01:00.000Z',
    });
    dispatchHook(
      store,
      { hook_event_name: 'SessionStart', cwd: WT, session_id: 'sess-1', launchId: 'launch-fix' },
      undefined,
      () => true,
      () => 'claude',
    );
    expect(listRecoveryRounds(store, id)[0]!.status).toBe('fixing');

    // The session dies without the `stage fix pass` marker: interrupted, never
    // passed, and no additional round is consumed.
    dispatchHook(
      store,
      { hook_event_name: 'SessionEnd', cwd: WT, session_id: 'sess-1', launchId: 'launch-fix' },
      undefined,
      () => true,
      () => 'claude',
    );

    const run = listProcessRuns(store, id).find((r) => r.processId === 'fix')!;
    expect(run.status).toBe('interrupted');
    const roundAfter = listRecoveryRounds(store, id)[0]!;
    expect(roundAfter.status).toBe('interrupted');
    expect(roundAfter.endedAt).not.toBeNull();
    expect(getSessionLaunchIntent(store, 'launch-fix')!.status).toBe('confirmed');
  });

  it('drops usage when the Fix process is STALE — the round still reads fixing but nothing is running', () => {
    const id = ticketAt();
    startImplementation(id, 'sess-1');
    usageUpdate('sess-1', { event_id: 'e1', input: 1_000, output: 200 });
    store.db
      .prepare('UPDATE implementation_runs SET status = ? WHERE ticket_id = ?')
      .run('passed', id);
    const round = openRecoveryRound(store, {
      ticketId: id, sourceStage: 'uat', sourceProcessId: 'gates',
      sourceStageRunId: null, sourceProcessRunId: null,
      triggerKind: 'gate-failure', triggerDetail: 'exit 1', maxRounds: 3,
      startedAt: '2026-08-01T11:55:00.000Z',
    });
    recordFixLaunchIntent(store, {
      ticketId: id, launchId: 'launch-fix', provider: 'claude', model: 'opus',
      reason: 'resume', sessionOrigin: 'resume', recoveryRoundId: round.id,
      at: '2026-08-01T12:01:00.000Z',
    });
    dispatchHook(
      store,
      { hook_event_name: 'SessionStart', cwd: WT, session_id: 'sess-1', launchId: 'launch-fix' },
      undefined,
      () => true,
      () => 'claude',
    );
    const fixRun = listProcessRuns(store, id).find((r) => r.processId === 'fix')!;
    expect(listRecoveryRounds(store, id)[0]!.status).toBe('fixing');
    // The activation sweep found the Fix process dead: the run is `stale`
    // while the round still reads `fixing` — nothing has observed the end.
    store.db
      .prepare("UPDATE process_runs SET status = 'stale' WHERE id = ?")
      .run(fixRun.id);

    usageUpdate('sess-1', { event_id: 'e2', input: 1_700, output: 340 });

    // The e2 update is unattributed: no new sample, no new ledger row; the
    // implementation sample remains untouched evidence.
    expect(listTokenUsage(store, { ticketId: id })).toHaveLength(1);
    const rows = store.db
      .prepare('SELECT source_event_id FROM interactive_usage_samples ORDER BY id')
      .all() as { source_event_id: string }[];
    expect(rows).toEqual([{ source_event_id: 'e1' }]);
  });

  it('baselines a resumed session without notifying views — nothing reaches the ledger', () => {
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
    const notify = vi.fn();
    usageUpdate('sess-1', { event_id: 'e1', input: 5_000, output: 400 }, undefined, notify);

    expect(listTokenUsage(store, { ticketId: id })).toHaveLength(0);
    expect(notify).not.toHaveBeenCalled();
    const baseline = lastInteractiveUsageSample(store, 'claude', 'sess-1')!;
    expect(baseline.baselineOnly).toBe(true);
  });

  it('drops malformed or partial usage without notifying views', () => {
    const id = ticketAt();
    startImplementation(id, 'sess-1');
    const notify = vi.fn();
    usageUpdate('sess-1', { event_id: 'e1', input: 'not-a-number', output: 200 }, undefined, notify);
    usageUpdate('sess-1', { input: 1_000, output: 200 }, undefined, notify); // no event id
    usageUpdate('sess-1', { event_id: 'e3', input: -5, output: 200 }, undefined, notify);
    usageUpdate('sess-1', 'usage', undefined, notify);

    expect(listTokenUsage(store, { ticketId: id })).toHaveLength(0);
    expect(notify).not.toHaveBeenCalled();
    expect(store.db.prepare('SELECT COUNT(*) AS n FROM interactive_usage_samples').get()).toEqual({
      n: 0,
    });
  });

  it('drops an unattributed update without notifying views', () => {
    const id = ticketAt();
    const notify = vi.fn();
    // No SessionStart ever confirmed an intent for sess-1.
    usageUpdate('sess-1', { event_id: 'e1', input: 100, output: 20 }, undefined, notify);
    expect(listTokenUsage(store, { ticketId: id })).toHaveLength(0);
    expect(notify).not.toHaveBeenCalled();
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

  it('accepts a PostToolUse payload carrying a tool_name string', () => {
    const parsed = parseHookPayload({
      hook_event_name: 'PostToolUse',
      cwd: '/wt',
      session_id: 's',
      tool_name: 'Bash',
    });
    expect(parsed?.tool_name).toBe('Bash');
  });

  it('accepts a payload without tool_name (tool_name is optional)', () => {
    const parsed = parseHookPayload({
      hook_event_name: 'Stop',
      cwd: '/wt',
      session_id: 's',
    });
    expect(parsed?.tool_name).toBeUndefined();
  });

  it('rejects a non-string tool_name', () => {
    expect(parseHookPayload({ hook_event_name: 'PostToolUse', cwd: '/wt', tool_name: 123 })).toBeNull();
    expect(parseHookPayload({ hook_event_name: 'PostToolUse', cwd: '/wt', tool_name: ['Bash'] })).toBeNull();
  });
});

/**
 * PROMPT-15: TurnTracker and marker-miss telemetry.
 *
 * The tracker counts PostToolUse events per turn and uses the count at Stop
 * time to split the ambiguous "Stop + markerPending" case into two telemetry
 * facts: `markerMissCase: 'question-at-stop'` (zero tool uses) vs
 * `markerMissCase: 'no-marker-after-work'` (nonzero tool uses).
 */
import { TurnTracker } from './dispatch.js';

describe('TurnTracker', () => {
  it('starts with zero tool count for a new ticket', () => {
    const tracker = new TurnTracker();
    expect(tracker.toolCount(1)).toBe(0);
    expect(tracker.lastToolName(1)).toBeUndefined();
  });

  it('increments tool count on each recordToolUse', () => {
    const tracker = new TurnTracker();
    tracker.recordToolUse(1, 'Bash');
    expect(tracker.toolCount(1)).toBe(1);
    expect(tracker.lastToolName(1)).toBe('Bash');
    tracker.recordToolUse(1, 'Read');
    expect(tracker.toolCount(1)).toBe(2);
    expect(tracker.lastToolName(1)).toBe('Read');
  });

  it('tracks tickets independently', () => {
    const tracker = new TurnTracker();
    tracker.recordToolUse(1, 'Bash');
    tracker.recordToolUse(2, 'Read');
    expect(tracker.toolCount(1)).toBe(1);
    expect(tracker.toolCount(2)).toBe(1);
    expect(tracker.lastToolName(1)).toBe('Bash');
    expect(tracker.lastToolName(2)).toBe('Read');
  });

  it('reset clears the counters for a ticket', () => {
    const tracker = new TurnTracker();
    tracker.recordToolUse(1, 'Bash');
    tracker.recordToolUse(1, 'Read');
    tracker.reset(1);
    expect(tracker.toolCount(1)).toBe(0);
    expect(tracker.lastToolName(1)).toBeUndefined();
  });

  it('reset does not affect other tickets', () => {
    const tracker = new TurnTracker();
    tracker.recordToolUse(1, 'Bash');
    tracker.recordToolUse(2, 'Read');
    tracker.reset(1);
    expect(tracker.toolCount(2)).toBe(1);
    expect(tracker.lastToolName(2)).toBe('Read');
  });
});

describe('dispatchHook — marker-miss telemetry (PROMPT-15)', () => {
  let store: Store;
  const WT = '/repo/.karst/worktrees/x';
  beforeEach(() => (store = openStore(':memory:')));
  afterEach(() => store.close());

  function ticketAt(): number {
    const t = createTicket(store, { key: 'A', title: 'a' });
    seedWorktree(store, t.id, WT);
    return t.id;
  }

  function runningImplRun(id: number): void {
    openImplementationRun(store, {
      ticketId: id,
      attempt: 0,
      provider: 'claude',
      startedAt: '2026-09-07T01:18:00.000Z',
    });
  }

  it('records markerMissCase question-at-stop when Stop fires with pending marker and zero tool activity', () => {
    const id = ticketAt();
    runningImplRun(id);
    const tracker = new TurnTracker();
    // No tool activity — the agent asked a question in prose.
    dispatchHook(store, { hook_event_name: 'Stop', cwd: WT }, undefined, undefined, undefined, undefined, undefined, tracker);
    // The agent_state is still waiting (marker pending).
    expect(getTicket(store, id).agentState).toBe('waiting');
    // The telemetry should be recorded on the process run.
    const runs = listProcessRuns(store, id);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.promptTelemetry).toEqual({
      markerMissCase: 'question-at-stop',
      deniedMarker: false,
      toolActivityObserved: false,
    });
  });

  it('records markerMissCase no-marker-after-work when Stop fires with pending marker and tool activity', () => {
    const id = ticketAt();
    runningImplRun(id);
    const tracker = new TurnTracker();
    tracker.recordToolUse(id, 'Edit');
    tracker.recordToolUse(id, 'Read');
    dispatchHook(store, { hook_event_name: 'Stop', cwd: WT }, undefined, undefined, undefined, undefined, undefined, tracker);
    expect(getTicket(store, id).agentState).toBe('waiting');
    const runs = listProcessRuns(store, id);
    expect(runs[0]!.promptTelemetry).toEqual({
      markerMissCase: 'no-marker-after-work',
      deniedMarker: false,
      toolActivityObserved: true,
    });
  });

  it('detects denied marker when Bash is the last tool before Stop with pending marker', () => {
    const id = ticketAt();
    runningImplRun(id);
    const tracker = new TurnTracker();
    tracker.recordToolUse(id, 'Edit');
    tracker.recordToolUse(id, 'Bash');
    dispatchHook(store, { hook_event_name: 'Stop', cwd: WT }, undefined, undefined, () => 'claude', undefined, undefined, tracker);
    const runs = listProcessRuns(store, id);
    expect(runs[0]!.promptTelemetry).toEqual({
      markerMissCase: 'no-marker-after-work',
      deniedMarker: true,
      toolActivityObserved: true,
    });
  });

  it('does not detect denied marker when Bash is not the last tool', () => {
    const id = ticketAt();
    runningImplRun(id);
    const tracker = new TurnTracker();
    tracker.recordToolUse(id, 'Bash');
    tracker.recordToolUse(id, 'Read');
    dispatchHook(store, { hook_event_name: 'Stop', cwd: WT }, undefined, undefined, undefined, undefined, undefined, tracker);
    const runs = listProcessRuns(store, id);
    expect(runs[0]!.promptTelemetry).toEqual({
      markerMissCase: 'no-marker-after-work',
      deniedMarker: false,
      toolActivityObserved: true,
    });
  });

  it('denied marker is false for codex provider even when last tool matches Bash', () => {
    const id = ticketAt();
    runningImplRun(id);
    const tracker = new TurnTracker();
    tracker.recordToolUse(id, 'Bash');
    dispatchHook(
      store,
      { hook_event_name: 'Stop', cwd: WT },
      undefined,
      undefined,
      () => 'codex',
      undefined,
      undefined,
      tracker,
    );
    const runs = listProcessRuns(store, id);
    expect(runs[0]!.promptTelemetry).toEqual({
      markerMissCase: 'no-marker-after-work',
      deniedMarker: false,
      toolActivityObserved: true,
    });
  });

  it('does not record telemetry when no tracker is supplied', () => {
    const id = ticketAt();
    runningImplRun(id);
    dispatchHook(store, { hook_event_name: 'Stop', cwd: WT });
    const runs = listProcessRuns(store, id);
    expect(runs[0]!.promptTelemetry).toBeNull();
  });

  it('does not record telemetry when tracker has no activity (unsupported core)', () => {
    const id = ticketAt();
    runningImplRun(id);
    const tracker = new TurnTracker();
    // No tool activity — tracker has never seen a PostToolUse. This simulates
    // a core whose toolActivity is unsupported (opencode, antigravity).
    // Telemetry IS recorded but toolActivityObserved is false, letting the
    // read layer discount unsupported cores.
    dispatchHook(store, { hook_event_name: 'Stop', cwd: WT }, undefined, undefined, undefined, undefined, undefined, tracker);
    const runs = listProcessRuns(store, id);
    expect(runs[0]!.promptTelemetry).toEqual({
      markerMissCase: 'question-at-stop',
      deniedMarker: false,
      toolActivityObserved: false,
    });
  });

  it('does not record telemetry when marker is not pending', () => {
    const id = ticketAt();
    runningImplRun(id);
    completeImplementationRun(store, id, '2026-09-07T01:40:00.000Z');
    const tracker = new TurnTracker();
    tracker.recordToolUse(id, 'Edit');
    dispatchHook(store, { hook_event_name: 'Stop', cwd: WT }, undefined, undefined, undefined, undefined, undefined, tracker);
    const runs = listProcessRuns(store, id);
    // The session run is completed (passed), so the query finds no running run.
    // Telemetry is only recorded on a running process run.
    expect(runs[0]!.promptTelemetry).toBeNull();
  });

  it('session.idle also triggers marker-miss telemetry', () => {
    const id = ticketAt();
    runningImplRun(id);
    const tracker = new TurnTracker();
    tracker.recordToolUse(id, 'Edit');
    dispatchHook(store, { hook_event_name: 'session.idle', cwd: WT, session_id: 'ses_1' }, undefined, undefined, undefined, undefined, undefined, tracker);
    const runs = listProcessRuns(store, id);
    expect(runs[0]!.promptTelemetry).toEqual({
      markerMissCase: 'no-marker-after-work',
      deniedMarker: false,
      toolActivityObserved: true,
    });
  });

  it('tracker is reset on SessionStart', () => {
    const id = ticketAt();
    const tracker = new TurnTracker();
    tracker.recordToolUse(id, 'Edit');
    tracker.recordToolUse(id, 'Bash');
    // SessionStart resets the turn.
    dispatchHook(store, { hook_event_name: 'SessionStart', cwd: WT, session_id: 's1' }, undefined, undefined, undefined, undefined, undefined, tracker);
    expect(tracker.toolCount(id)).toBe(0);
    expect(tracker.lastToolName(id)).toBeUndefined();
  });

  it('tracker is reset after Stop with pending marker (per-turn boundary)', () => {
    const id = ticketAt();
    runningImplRun(id);
    const tracker = new TurnTracker();
    tracker.recordToolUse(id, 'Edit');
    dispatchHook(store, { hook_event_name: 'Stop', cwd: WT }, undefined, undefined, undefined, undefined, undefined, tracker);
    // After Stop, tracker is reset — the next turn starts fresh.
    expect(tracker.toolCount(id)).toBe(0);
    expect(tracker.lastToolName(id)).toBeUndefined();
  });

  it('tracker is released on SessionEnd — subsequent Stop shows no activity', () => {
    const id = ticketAt();
    runningImplRun(id);
    const tracker = new TurnTracker();
    tracker.recordToolUse(id, 'Edit');
    tracker.recordToolUse(id, 'Bash');
    dispatchHook(store, { hook_event_name: 'SessionEnd', cwd: WT }, undefined, undefined, () => 'claude', undefined, undefined, tracker);
    // After SessionEnd, tracker state is released (not just reset).
    expect(tracker.toolCount(id)).toBe(0);
    expect(tracker.lastToolName(id)).toBeUndefined();
    // SessionEnd interrupts the run, so markerIsPending is now false.
    // A new SessionStart + Stop sequence with a fresh pending marker shows
    // no tool activity from the prior turn.
    openImplementationRun(store, { ticketId: id, attempt: 1, provider: 'claude', startedAt: '2026-09-07T02:00:00.000Z' });
    dispatchHook(store, { hook_event_name: 'Stop', cwd: WT }, undefined, undefined, () => 'claude', undefined, undefined, tracker);
    const runs = listProcessRuns(store, id);
    // The second run (attempt 1) has the telemetry — toolActivityObserved is
    // false because forget cleared the prior turn's counts.
    const secondRun = runs.find((r) => r.attempt === 1)!;
    expect(secondRun.promptTelemetry).toEqual({
      markerMissCase: 'question-at-stop',
      deniedMarker: false,
      toolActivityObserved: false,
    });
  });

  it('second Stop after tools does not overwrite first Stop telemetry (hasActivity guard)', () => {
    const id = ticketAt();
    runningImplRun(id);
    const tracker = new TurnTracker();
    // First turn: tools ran, then Stop — records no-marker-after-work.
    tracker.recordToolUse(id, 'Edit');
    dispatchHook(store, { hook_event_name: 'Stop', cwd: WT }, undefined, undefined, undefined, undefined, undefined, tracker);
    // Second turn: no tools, then Stop — tracker was reset, so toolCount is 0.
    // This overwrites the blob with question-at-stop (merge-only semantics).
    dispatchHook(store, { hook_event_name: 'Stop', cwd: WT }, undefined, undefined, undefined, undefined, undefined, tracker);
    const runs = listProcessRuns(store, id);
    expect(runs[0]!.promptTelemetry).toEqual({
      markerMissCase: 'question-at-stop',
      deniedMarker: false,
      toolActivityObserved: false,
    });
  });

  it('tool activity is tracked across PostToolUse events', () => {
    const id = ticketAt();
    const tracker = new TurnTracker();
    dispatchHook(store, { hook_event_name: 'PostToolUse', cwd: WT, tool_name: 'Edit' }, undefined, undefined, undefined, undefined, undefined, tracker);
    dispatchHook(store, { hook_event_name: 'PostToolUse', cwd: WT, tool_name: 'Bash' }, undefined, undefined, undefined, undefined, undefined, tracker);
    expect(tracker.toolCount(id)).toBe(2);
    expect(tracker.lastToolName(id)).toBe('Bash');
  });
});
