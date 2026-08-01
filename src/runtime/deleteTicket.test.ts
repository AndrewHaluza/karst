import { describe, expect, it, vi } from 'vitest';
import { openStore } from '../store/db.js';
import { createTicket, getTicket } from '../store/tickets.js';
import { deleteTicketPermanently } from './deleteTicket.js';

describe('deleteTicketPermanently', () => {
  it('closes the bound panel, deletes rows, and waits for attachment cleanup', async () => {
    const store = openStore(':memory:');
    const ticket = createTicket(store, { key: 'DELETE-1', title: 'delete me' });
    let releaseCleanup: (() => void) | undefined;
    const cleanup = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    const closePanel = vi.fn(() => {
      expect(() => getTicket(store, ticket.id)).toThrow();
    });
    const reap = vi.fn(async () => {
      expect(() => getTicket(store, ticket.id)).toThrow();
      await cleanup;
    });
    let settled = false;

    const deleting = deleteTicketPermanently(store, ticket.id, { closePanel, reap })
      .then(() => {
        settled = true;
      });
    await Promise.resolve();

    expect(closePanel).toHaveBeenCalledWith(ticket.id);
    expect(reap).toHaveBeenCalledWith(ticket.id);
    expect(settled).toBe(false);

    releaseCleanup?.();
    await deleting;
    expect(settled).toBe(true);
    store.close();
  });

  it('propagates attachment cleanup failure after deleting the ticket', async () => {
    const store = openStore(':memory:');
    const ticket = createTicket(store, { key: 'DELETE-2', title: 'delete me too' });

    await expect(deleteTicketPermanently(store, ticket.id, {
      closePanel: () => {},
      reap: async () => {
        throw new Error('disk denied');
      },
    })).rejects.toThrow('disk denied');

    expect(() => getTicket(store, ticket.id)).toThrow();
    store.close();
  });
});
