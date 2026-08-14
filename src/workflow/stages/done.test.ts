import { describe, it, expect } from 'vitest';
import { openStore, type Store } from '../../store/db.js';
import { createTicketFlow } from './create.js';
import { updateTicketFields, getTicket } from '../../store/tickets.js';
import { providerRef, advanceTicketOnShip, statusPushSkipNote } from './done.js';
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
  advanceOnShip: true,
  shipStatus: 'in review',
};

/** A ticket carrying a provider ref — the only kind that is addressable. */
function fetchedTicket(store: Store, ref = 'abc123'): number {
  const id = createTicketFlow(store, { key: 'PROJ-1', title: 't' }).id;
  updateTicketFields(store, id, { sourceRef: ref });
  return id;
}

describe('providerRef', () => {
  it('returns the sourceRef the provider gave us', () => {
    const store = openStore(':memory:');
    const id = fetchedTicket(store);
    expect(providerRef(getTicket(store, id))).toBe('abc123');
  });

  it('returns null for a manual ticket with a hand-typed key and no ref', () => {
    const store = openStore(':memory:');
    // The hazard case: `key` looks like a task id but was never fetched from any
    // provider. Addressing it would move an unrelated ClickUp task.
    const id = createTicketFlow(store, { key: 'abc123', title: 't' }).id;
    expect(providerRef(getTicket(store, id))).toBeNull();
  });

  it('treats a blank sourceRef as no ref', () => {
    const store = openStore(':memory:');
    const id = fetchedTicket(store, '   ');
    expect(providerRef(getTicket(store, id))).toBeNull();
  });
});

describe('advanceTicketOnShip', () => {
  it('pushes the configured status using the sourceRef', async () => {
    const store = openStore(':memory:');
    const id = fetchedTicket(store);
    const provider = recorder();

    const res = await advanceTicketOnShip(store, id, ON, provider);

    expect(res).toEqual({ advanced: true, status: 'in review' });
    expect(provider.updates).toEqual([{ ref: 'abc123', status: 'in review' }]);
  });

  it('does nothing when advanceOnShip is false', async () => {
    const store = openStore(':memory:');
    const id = fetchedTicket(store);
    const provider = recorder();

    const res = await advanceTicketOnShip(
      store, id, { provider: 'clickup', advanceOnShip: false, shipStatus: 'in review' }, provider,
    );

    expect(res).toEqual({ advanced: false, reason: 'disabled' });
    expect(provider.updates).toEqual([]);
  });

  it('does nothing when there is no ticketing config at all', async () => {
    const store = openStore(':memory:');
    const id = fetchedTicket(store);
    const provider = recorder();

    const res = await advanceTicketOnShip(store, id, undefined, provider);

    expect(res).toEqual({ advanced: false, reason: 'disabled' });
    expect(provider.updates).toEqual([]);
  });

  it('does nothing when shipStatus is blank', async () => {
    const store = openStore(':memory:');
    const id = fetchedTicket(store);
    const provider = recorder();

    const res = await advanceTicketOnShip(
      store, id, { provider: 'clickup', advanceOnShip: true, shipStatus: '  ' }, provider,
    );

    expect(res).toEqual({ advanced: false, reason: 'disabled' });
    expect(provider.updates).toEqual([]);
  });

  it('refuses to push when the ticket has no provider ref', async () => {
    const store = openStore(':memory:');
    const id = createTicketFlow(store, { key: 'abc123', title: 't' }).id;
    const provider = recorder();

    const res = await advanceTicketOnShip(store, id, ON, provider);

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

    await expect(advanceTicketOnShip(store, id, ON, provider)).rejects.toThrow(/401/);
  });
});

describe('statusPushSkipNote', () => {
  it('returns null when the push advanced', () => {
    expect(statusPushSkipNote('started', 3, { advanced: true, status: 'in progress' })).toBeNull();
  });

  it('returns null when the push is configured off', () => {
    expect(statusPushSkipNote('completed', 3, { advanced: false, reason: 'disabled' })).toBeNull();
  });

  it('describes a no-ref skip as a DEBUG note, never an error', () => {
    expect(statusPushSkipNote('started', 3, { advanced: false, reason: 'no-ref' })).toEqual({
      level: 'debug',
      message: 'ticket #3 started without a status update: no provider ref',
    });
  });

  it('words the completed event as completed', () => {
    expect(statusPushSkipNote('completed', 3, { advanced: false, reason: 'no-ref' })).toEqual({
      level: 'debug',
      message: 'ticket #3 completed without a status update: no provider ref',
    });
  });
});
