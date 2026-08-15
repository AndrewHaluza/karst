import { describe, expect, it, vi } from 'vitest';
import { openStore } from '../store/db.js';
import { createTicket, getTicket } from '../store/tickets.js';
import { openProcessRun, listProcessRuns } from '../store/processRuns.js';
import { recordTokenUsage, listTokenUsage } from '../store/tokenUsage.js';
import { recordFindings, listFindings } from '../store/reviewFindings.js';
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

  it('deletes a ticket whose evidence links to its process runs, ledger intact', async () => {
    const store = openStore(':memory:');
    const ticket = createTicket(store, { key: 'DELETE-3', title: 'linked' });
    const run = openProcessRun(store, {
      ticketId: ticket.id,
      stageKey: 'review',
      processId: 'review',
      attempt: 0,
      startedAt: '2026-08-01T10:00:00.000Z',
    });
    recordTokenUsage(store, {
      projectId: 1,
      ticketId: ticket.id,
      processRunId: run.id,
      callSite: 'fix-resume',
      outcome: 'ok',
      usage: {
        inputTokens: 60,
        outputTokens: 20,
        reasoningTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 80,
        model: null,
        estimated: false,
      },
    });
    recordFindings(store, {
      ticketId: ticket.id,
      attempt: 0,
      runAt: '2026-08-01T12:00:00.000Z',
      processRunId: run.id,
      findings: [
        {
          severity: 'high',
          repo: '/web',
          file: null,
          line: null,
          title: 'boom',
          detail: 'd',
          source: 'agent',
        },
      ],
    });

    await deleteTicketPermanently(store, ticket.id, {
      closePanel: () => {},
      reap: async () => {},
    });

    expect(() => getTicket(store, ticket.id)).toThrow();
    expect(listProcessRuns(store, ticket.id)).toEqual([]);
    expect(listFindings(store, ticket.id)).toEqual([]);
    // The surviving ledger row keeps its counts, unattributed to ticket or run.
    const surviving = listTokenUsage(store, {});
    expect(surviving).toHaveLength(1);
    expect(surviving[0]!.ticketId).toBeNull();
    expect(surviving[0]!.processRunId).toBeNull();
    expect(surviving[0]!.totalTokens).toBe(80);
    store.close();
  });
});
