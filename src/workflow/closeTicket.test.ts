import { describe, it, expect } from 'vitest';
import { openStore } from '../store/db.js';
import { createTicketFlow } from './stages/create.js';
import { getTicket } from '../store/tickets.js';
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
