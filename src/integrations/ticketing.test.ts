import { describe, it, expect } from 'vitest';
import { manualProvider, makeTicketingProvider } from './ticketing.js';

const noopFetch = (async () => new Response('{}')) as unknown as typeof fetch;
const token = async (): Promise<string> => 'tok';

describe('manualProvider', () => {
  it('records the status update without calling any external service', async () => {
    const provider = manualProvider();
    await provider.updateStatus('PROJ-1', 'done');
    expect(provider.updates).toEqual([{ key: 'PROJ-1', status: 'done' }]);
  });
});

describe('makeTicketingProvider', () => {
  it('returns a manual (non-fetching) provider when config is undefined', () => {
    const provider = makeTicketingProvider(undefined, noopFetch, token);
    expect(provider.fetchTicket).toBeUndefined();
  });

  it("returns a manual provider when provider is 'manual'", () => {
    const provider = makeTicketingProvider({ provider: 'manual' }, noopFetch, token);
    expect(provider.fetchTicket).toBeUndefined();
  });

  it("returns a fetching clickup provider when provider is 'clickup'", () => {
    const provider = makeTicketingProvider(
      { provider: 'clickup', teamId: '9001' },
      noopFetch,
      token,
    );
    expect(typeof provider.fetchTicket).toBe('function');
  });
});
