import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openStore, type Store } from '../../store/db.js';
import { createTicket, getTicket } from '../../store/tickets.js';
import { setStage } from '../../store/stages.js';
import type { StageStatus } from '../../model/types.js';
import { openTicketFromList, ticketListDestination } from './navigation.js';

describe('ticket-list navigation', () => {
  let store: Store;

  beforeEach(() => (store = openStore(':memory:')));
  afterEach(() => store.close());

  it.each<StageStatus>(['pending', 'running', 'failed', 'skipped'])(
    'opens editing while scope is %s',
    (status) => {
      const ticket = createTicket(store, { key: `DRAFT-${status}`, title: status });
      setStage(store, ticket.id, 'scope', { status });

      expect(ticketListDestination(getTicket(store, ticket.id))).toBe('edit');
    },
  );

  it('opens editing when the scope evidence is absent', () => {
    const ticket = createTicket(store, { key: 'DRAFT-ABSENT', title: 'absent' });
    const loaded = getTicket(store, ticket.id);

    expect(
      ticketListDestination({
        ...loaded,
        stages: loaded.stages.filter((stage) => stage.stageKey !== 'scope'),
      }),
    ).toBe('edit');
  });

  it('opens the dashboard only after scope passed', () => {
    const ticket = createTicket(store, { key: 'SCOPED-1', title: 'scoped' });
    setStage(store, ticket.id, 'scope', { status: 'passed' });

    expect(ticketListDestination(getTicket(store, ticket.id))).toBe('dashboard');
  });

  it('loads and dispatches the selected ticket id to exactly one correct destination', () => {
    const draft = createTicket(store, { key: 'DRAFT-1', title: 'draft' });
    const scoped = createTicket(store, { key: 'SCOPED-2', title: 'scoped' });
    setStage(store, scoped.id, 'scope', { status: 'passed' });
    const actions = { edit: vi.fn(), openDashboard: vi.fn(), onError: vi.fn() };

    openTicketFromList(store, draft.id, actions);
    openTicketFromList(store, scoped.id, actions);

    expect(actions.edit.mock.calls).toEqual([[draft.id]]);
    expect(actions.openDashboard.mock.calls).toEqual([[scoped.id]]);
  });

  it('reports an asynchronous destination failure instead of leaving it unhandled', async () => {
    const draft = createTicket(store, { key: 'DRAFT-ERROR', title: 'draft error' });
    const error = new Error('edit command rejected');
    const onError = vi.fn();

    openTicketFromList(store, draft.id, {
      edit: () => Promise.reject(error),
      openDashboard: vi.fn(),
      onError,
    });

    await vi.waitFor(() => expect(onError).toHaveBeenCalledWith(error));
  });
});
