import { describe, it, expect } from 'vitest';
import { manualProvider, makeTicketingProvider } from './ticketing.js';

const noopFetch = (async () => new Response('{}')) as unknown as typeof fetch;
const token = async (): Promise<string> => 'tok';

describe('manualProvider', () => {
  it('records the status update without calling any external service', async () => {
    const provider = manualProvider();
    await provider.updateStatus('PROJ-1', 'done');
    expect(provider.updates).toEqual([{ ref: 'PROJ-1', status: 'done' }]);
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

describe('makeTicketingProvider — listStatuses', () => {
  it('threads listId through to the clickup provider', async () => {
    const urls: string[] = [];
    const spyFetch = (async (url: string | URL) => {
      urls.push(String(url));
      return new Response(JSON.stringify({ statuses: [{ status: 'in review' }] }));
    }) as unknown as typeof fetch;

    const provider = makeTicketingProvider(
      { provider: 'clickup', listId: '42' },
      spyFetch,
      token,
    );

    expect(await provider.listStatuses!()).toEqual(['in review']);
    expect(urls[0]).toContain('/list/42');
  });

  it('gives the manual provider no listStatuses', () => {
    const provider = makeTicketingProvider({ provider: 'manual' }, noopFetch, token);
    expect(provider.listStatuses).toBeUndefined();
  });
});
