import { describe, it, expect } from 'vitest';
import { openStore } from '../store/db.js';
import { createTicketFlow } from './stages/create.js';
import { createTicket, getTicket, setAgentState } from '../store/tickets.js';
import { transition } from './machine.js';
import { STAGE_KEYS } from '../model/types.js';
import { deriveStageCurrent, reconcileOnStart } from '../recovery/reconcile.js';
import { closeTicket, reopenTicket } from './closeTicket.js';

function ticketAtImpl() {
  const store = openStore(':memory:');
  const id = createTicketFlow(store, { key: 'T', title: 't' }).id;
  transition(store, id, 'scope', { kind: 'passed' });
  return { store, id };
}

describe('closed is an operator exit, never a rail step', () => {
  it('is not in STAGE_KEYS, so a new ticket seeds no closed row', () => {
    const store = openStore(':memory:');
    const id = createTicketFlow(store, { key: 'T', title: 't' }).id;
    expect(STAGE_KEYS).not.toContain('closed');
    expect(getTicket(store, id).stages.some((s) => s.stageKey === 'closed')).toBe(false);
  });
});

describe('closeTicket', () => {
  it('moves the ticket to closed and records reason and ref', () => {
    const { store, id } = ticketAtImpl();
    closeTicket(store, id, { reason: 'Sam did it in CU-123', ref: 'https://x/CU-123' });
    const t = getTicket(store, id);
    expect(t.stageCurrent).toBe('closed');
    const row = t.stages.find((s) => s.stageKey === 'closed');
    expect(row?.status).toBe('passed');
    expect(row?.verdict).toBe('Sam did it in CU-123 (https://x/CU-123)');
    expect(row?.endedAt).not.toBeNull();
  });

  it('leaves the stages it passed through untouched as history', () => {
    const { store, id } = ticketAtImpl();
    closeTicket(store, id, { reason: 'done elsewhere' });
    const impl = getTicket(store, id).stages.find((s) => s.stageKey === 'impl');
    expect(impl?.status).toBe('running');
  });

  it('requires a non-blank reason', () => {
    const { store, id } = ticketAtImpl();
    expect(() => closeTicket(store, id, { reason: '   ' })).toThrow(/reason/);
    expect(getTicket(store, id).stageCurrent).toBe('impl');
  });

  it('refuses a ticket that is already done or closed', () => {
    const { store, id } = ticketAtImpl();
    closeTicket(store, id, { reason: 'r' });
    expect(() => closeTicket(store, id, { reason: 'r' })).toThrow(/closed/);
    store.db.prepare("UPDATE tickets SET stage_current = 'done' WHERE id = ?").run(id);
    expect(() => closeTicket(store, id, { reason: 'r' })).toThrow(/done/);
  });
});

describe('a closed ticket stays closed', () => {
  it('deriveStageCurrent reads the closed row', () => {
    const { store, id } = ticketAtImpl();
    closeTicket(store, id, { reason: 'r' });
    expect(deriveStageCurrent(getTicket(store, id).stages)).toBe('closed');
  });

  it('reconcileOnStart does not resurrect it', () => {
    const { store, id } = ticketAtImpl();
    closeTicket(store, id, { reason: 'r' });
    reconcileOnStart(store, () => false);
    expect(getTicket(store, id).stageCurrent).toBe('closed');
  });
});

describe('reopenTicket', () => {
  it('returns a closed ticket to a running impl and drops the closed row', () => {
    const { store, id } = ticketAtImpl();
    closeTicket(store, id, { reason: 'r' });
    reopenTicket(store, id);
    const t = getTicket(store, id);
    expect(t.stageCurrent).toBe('impl');
    expect(t.stages.find((s) => s.stageKey === 'impl')?.status).toBe('running');
    expect(t.stages.some((s) => s.stageKey === 'closed')).toBe(false);
  });

  it('refuses a ticket that is not closed', () => {
    const { store, id } = ticketAtImpl();
    expect(() => reopenTicket(store, id)).toThrow(/not closed/);
  });
});

describe('closeTicket cleanup', () => {
  it('releases a queued autostart so a closed sub-task never starts', () => {
    const store = openStore(':memory:');
    const parent = createTicket(store, { key: 'P', title: 'p' });
    const child = createTicket(store, {
      key: 'C',
      title: 'c',
      subtaskParentId: parent.id,
      autostartPending: true,
    });
    expect(getTicket(store, child.id).autostartPending).toBe(true);
    closeTicket(store, child.id, { reason: 'r' });
    const t = getTicket(store, child.id);
    expect(t.autostartPending).toBe(false);
    expect(t.autostartStarting).toBe(false);
    expect(t.autostartClaimedAt).toBeNull();
  });

  it('resets a stale live agent state', () => {
    const { store, id } = ticketAtImpl();
    setAgentState(store, id, 'waiting');
    closeTicket(store, id, { reason: 'r' });
    expect(getTicket(store, id).agentState).toBe('none');
  });

  it('refuses while an open sub-task exists and changes nothing', () => {
    const store = openStore(':memory:');
    const parent = createTicket(store, { key: 'P', title: 'p' });
    createTicket(store, { key: 'C', title: 'c', subtaskParentId: parent.id });
    expect(() => closeTicket(store, parent.id, { reason: 'r' })).toThrow(/open sub-tasks \(C\)/);
    expect(getTicket(store, parent.id).stageCurrent).toBe('scope');
  });

  it('allows closing a parent whose sub-tasks are all finished', () => {
    const store = openStore(':memory:');
    const parent = createTicket(store, { key: 'P', title: 'p' });
    const child = createTicket(store, { key: 'C', title: 'c', subtaskParentId: parent.id });
    closeTicket(store, child.id, { reason: 'child done elsewhere' });
    expect(() => closeTicket(store, parent.id, { reason: 'r' })).not.toThrow();
  });

  it('reports what it left behind: open PRs, worktrees and running servers', () => {
    const { store, id } = ticketAtImpl();
    store.db.prepare("INSERT INTO prs (ticket_id, repo, number, status) VALUES (?, 'a', 1, 'open')").run(id);
    store.db.prepare("INSERT INTO prs (ticket_id, repo, number, status) VALUES (?, 'b', 2, 'merged')").run(id);
    store.db.prepare("INSERT INTO worktrees (ticket_id, repo, path) VALUES (?, 'a', '/w/a')").run(id);
    store.db
      .prepare("INSERT INTO servers (ticket_id, repo, host, port, pid, status, log_path) VALUES (?, 'a', 'h', 1, 2, 'running', '/l')")
      .run(id);
    store.db
      .prepare("INSERT INTO servers (ticket_id, repo, host, port, pid, status, log_path) VALUES (?, 'b', 'h', 2, NULL, 'stopped', '/l')")
      .run(id);
    expect(closeTicket(store, id, { reason: 'r' })).toEqual({
      openPrs: 1,
      worktrees: 1,
      runningServers: 1,
    });
  });
});
