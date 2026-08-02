import { describe, it, expect } from 'vitest';
import { openStore, type Store } from '../../store/db.js';
import { createTicketFlow } from './create.js';
import { updateTicketFields } from '../../store/tickets.js';
import { advanceTicketOnStart, DEFAULT_START_STATUS } from './start.js';
import type { TicketingProvider } from '../../integrations/ticketing.js';
import type { TicketingConfig } from '../../manifest/types.js';

/** A provider double that records what it was asked to set. */
function recorder(): TicketingProvider & { updates: { ref: string; status: string }[] } {
  const updates: { ref: string; status: string }[] = [];
  return {
    updates,
    async updateStatus(ref, status) {
      updates.push({ ref, status });
    },
  };
}

const ON: TicketingConfig = {
  provider: 'clickup',
  advanceOnStart: true,
  startStatus: 'in dev',
};

/** A ticket carrying a provider ref — the only kind that is addressable. */
function fetchedTicket(store: Store, ref = 'abc123'): number {
  const id = createTicketFlow(store, { key: 'PROJ-1', title: 't' }).id;
  updateTicketFields(store, id, { sourceRef: ref });
  return id;
}

describe('advanceTicketOnStart', () => {
  it('pushes the configured status using the sourceRef', async () => {
    const store = openStore(':memory:');
    const id = fetchedTicket(store);
    const provider = recorder();

    const res = await advanceTicketOnStart(store, id, ON, provider);

    expect(res).toEqual({ advanced: true, status: 'in dev' });
    expect(provider.updates).toEqual([{ ref: 'abc123', status: 'in dev' }]);
  });

  it('falls back to the default status when startStatus is unconfigured', async () => {
    const store = openStore(':memory:');
    const id = fetchedTicket(store);
    const provider = recorder();

    const res = await advanceTicketOnStart(
      store, id, { provider: 'clickup', advanceOnStart: true }, provider,
    );

    expect(res).toEqual({ advanced: true, status: DEFAULT_START_STATUS });
    expect(provider.updates).toEqual([{ ref: 'abc123', status: DEFAULT_START_STATUS }]);
  });

  it('falls back to the default status when startStatus is blank', async () => {
    const store = openStore(':memory:');
    const id = fetchedTicket(store);
    const provider = recorder();

    const res = await advanceTicketOnStart(
      store, id, { provider: 'clickup', advanceOnStart: true, startStatus: '   ' }, provider,
    );

    expect(res).toEqual({ advanced: true, status: DEFAULT_START_STATUS });
  });

  it('does nothing when advanceOnStart is false', async () => {
    const store = openStore(':memory:');
    const id = fetchedTicket(store);
    const provider = recorder();

    const res = await advanceTicketOnStart(
      store, id, { provider: 'clickup', advanceOnStart: false, startStatus: 'in dev' }, provider,
    );

    expect(res).toEqual({ advanced: false, reason: 'disabled' });
    expect(provider.updates).toEqual([]);
  });

  it('does nothing when there is no ticketing config at all', async () => {
    const store = openStore(':memory:');
    const id = fetchedTicket(store);
    const provider = recorder();

    const res = await advanceTicketOnStart(store, id, undefined, provider);

    expect(res).toEqual({ advanced: false, reason: 'disabled' });
    expect(provider.updates).toEqual([]);
  });

  it('refuses to push when the ticket has no provider ref', async () => {
    const store = openStore(':memory:');
    const id = createTicketFlow(store, { key: 'abc123', title: 't' }).id;
    const provider = recorder();

    const res = await advanceTicketOnStart(store, id, ON, provider);

    expect(res).toEqual({ advanced: false, reason: 'no-ref' });
    expect(provider.updates).toEqual([]);
  });

  it('lets a provider error propagate to the caller', async () => {
    const store = openStore(':memory:');
    const id = fetchedTicket(store);
    const provider: TicketingProvider = {
      async updateStatus() {
        throw new Error('ClickUp: PUT returned 401');
      },
    };

    await expect(advanceTicketOnStart(store, id, ON, provider)).rejects.toThrow(/401/);
  });
});
