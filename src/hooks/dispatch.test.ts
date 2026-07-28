import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { openStore, type Store } from '../store/db.js';
import { createTicket, getTicket } from '../store/tickets.js';
import { dispatchHook, parseHookPayload } from './dispatch.js';

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
    dispatchHook(store, { hook_event_name: 'Notification', cwd: WT, message: 'idle_prompt' });
    dispatchHook(store, { hook_event_name: 'UserPromptSubmit', cwd: WT });
    expect(getTicket(store, id).agentState).toBe('running');
  });

  it('PostToolUse flips a waiting agent back to running', () => {
    const id = ticketAt();
    dispatchHook(store, { hook_event_name: 'Notification', cwd: WT, message: 'idle_prompt' });
    dispatchHook(store, { hook_event_name: 'PostToolUse', cwd: WT });
    expect(getTicket(store, id).agentState).toBe('running');
  });

  it('Stop never infers a stage transition — stage_current is untouched', () => {
    const id = ticketAt();
    const before = getTicket(store, id).stageCurrent;
    dispatchHook(store, { hook_event_name: 'Stop', cwd: WT });
    expect(getTicket(store, id).stageCurrent).toBe(before);
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
});
