import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openStore, type Store } from '../store/db.js';
import { createTicket } from '../store/tickets.js';
import type { ServerInventory } from '../store/serverInventory.js';
import { SERVER_STATUS_WORD } from '../model/serverStatusText.js';
import { makeServerLogsBinding } from './serverLogsBinding.js';

describe('makeServerLogsBinding', () => {
  let store: Store;
  beforeEach(() => {
    store = openStore(':memory:');
  });
  afterEach(() => store.close());

  const bind = (inventory: () => ServerInventory | undefined) => {
    const writeClipboard = vi.fn(async () => {});
    const ticketKeyOf = vi.fn((id: number) => (id === 1 ? 'FEAT-1' : null));
    const binding = makeServerLogsBinding({ store, ticketKeyOf, inventory, writeClipboard });
    return { binding, writeClipboard, ticketKeyOf };
  };

  it('lists the log rows of a ticket with their status word', () => {
    const t = createTicket(store, { key: 'A', title: 'a', projectId: 1 });
    const ins = store.db.prepare(
      "INSERT INTO servers (ticket_id, repo, host, port, pid, status, log_path) VALUES (?, ?, 'localhost', 3001, 1, ?, ?)",
    );
    ins.run(t.id, 'api', 'running', '/logs/api.log');
    ins.run(t.id, 'web', 'failed', '/logs/web.log');
    const { binding } = bind(() => undefined);
    expect(binding.logServers(t.id)).toEqual([
      { service: 'api', logPath: '/logs/api.log', status: SERVER_STATUS_WORD.running },
      { service: 'web', logPath: '/logs/web.log', status: SERVER_STATUS_WORD.failed },
    ]);
  });

  it('wires the clipboard write and the ticket key into the manager options', async () => {
    const { binding, writeClipboard, ticketKeyOf } = bind(() => undefined);
    await binding.options.writeClipboard?.('text');
    expect(writeClipboard).toHaveBeenCalledWith('text');
    expect(binding.options.ticketKeyFor?.(1)).toBe('FEAT-1');
    expect(ticketKeyOf).toHaveBeenCalledWith(1);
  });

  it('lists the shared services of the inventory with a status word', () => {
    const inv = {
      shared: [
        { repo: 'api', logPath: '/logs/api.log', status: 'running' },
        { repo: 'db', logPath: null, status: 'stopped' },
      ],
      tickets: [],
    } as unknown as ServerInventory;
    const { binding } = bind(() => inv);
    expect(binding.options.sharedLogServers?.()).toEqual([
      { service: 'api', logPath: '/logs/api.log', status: SERVER_STATUS_WORD.running },
      { service: 'db', logPath: null, status: SERVER_STATUS_WORD.stopped },
    ]);
  });

  it('lists no shared service without an inventory', () => {
    expect(bind(() => undefined).binding.options.sharedLogServers?.()).toEqual([]);
  });

  it('lists no shared service when the inventory read throws', () => {
    const { binding } = bind(() => {
      throw new Error('boom');
    });
    expect(binding.options.sharedLogServers?.()).toEqual([]);
  });
});
