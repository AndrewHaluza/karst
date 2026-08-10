import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openStore, type Store } from '../store/db.js';
import { createTicket, getTicket } from '../store/tickets.js';
import { dispatchHook } from './dispatch.js';
import { ticketGlyph } from '../model/ticketGlyph.js';
import { buildNowLine } from '../model/nowLine.js';

/** Register a worktree row directly so a payload cwd resolves to a ticket. */
function seedWorktree(store: Store, ticketId: number, path: string): void {
  store.db
    .prepare(
      `INSERT INTO worktrees (ticket_id, repo, path, branch, base_ref, deps_mode)
       VALUES (?, 'app', ?, 'karst/x', 'main', 'inherited')`,
    )
    .run(ticketId, path);
}

/**
 * The agy conversation watch normalizes its reads of the CLI's conversation DB
 * into the CLOSED hook vocabulary (SessionStart / permission.asked /
 * UserPromptSubmit) — this pins that those exact payloads, dispatched, drive
 * the provider-agnostic needs-you display: the amber glyph and the waiting Now
 * line while the ask is pending, running/blue once the user answers.
 */
describe('agy conversation watch → dispatch → needs-you display', () => {
  let store: Store;
  const WT = '/repo/.karst/worktrees/agy';
  beforeEach(() => (store = openStore(':memory:')));
  afterEach(() => store.close());

  function ticketAt(): number {
    const t = createTicket(store, { key: 'A', title: 'a' });
    seedWorktree(store, t.id, WT);
    return t.id;
  }

  it('an agy permission ask renders amber "Needs you" and resolves to running', () => {
    const id = ticketAt();
    const sessionId = '11111111-1111-4111-8111-111111111111';

    // The watch emits SessionStart once it discovers the conversation id.
    dispatchHook(store, { hook_event_name: 'SessionStart', cwd: WT, session_id: sessionId });
    expect(getTicket(store, id).agentState).toBe('running');
    expect(ticketGlyph(getTicket(store, id))).toBe('blue');

    // ...and permission.asked while the CLI's steps table has a status=9 row.
    dispatchHook(store, {
      hook_event_name: 'permission.asked',
      cwd: WT,
      session_id: sessionId,
    });
    expect(getTicket(store, id).agentState).toBe('waiting');
    expect(ticketGlyph(getTicket(store, id))).toBe('amber');
    expect(
      buildNowLine({ stageKey: 'impl', status: 'running' }, { agentWaiting: true }).text,
    ).toBe('Now: the agent is waiting — it asked for your input.');

    // The user answers → the status=9 row resolves → the watch emits
    // UserPromptSubmit, which flips the amber back to running.
    dispatchHook(store, {
      hook_event_name: 'UserPromptSubmit',
      cwd: WT,
      session_id: sessionId,
    });
    expect(getTicket(store, id).agentState).toBe('running');
    expect(ticketGlyph(getTicket(store, id))).toBe('blue');
  });

  it('the captured session id survives the ask — resume keeps its target', () => {
    const id = ticketAt();
    const sessionId = '22222222-2222-4222-8222-222222222222';
    dispatchHook(store, { hook_event_name: 'SessionStart', cwd: WT, session_id: sessionId });
    dispatchHook(store, { hook_event_name: 'permission.asked', cwd: WT, session_id: sessionId });
    dispatchHook(store, { hook_event_name: 'UserPromptSubmit', cwd: WT, session_id: sessionId });
    expect(getTicket(store, id).sessionId).toBe(sessionId);
  });
});
