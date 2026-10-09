import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openStore, type Store } from '../../store/db.js';
import { createTicket, updateTicketFields } from '../../store/tickets.js';
import type { Manifest } from '../../manifest/types.js';
import { serviceNamesFor } from './resolvers.js';

const manifest = {
  repositories: {
    api: { path: '/api', service: { start: 'npm start', ports: [3000] } },
    web: {
      path: '/web',
      services: {
        front: { start: 'npm run front', ports: [3001] },
        back: { start: 'npm run back', ports: [3002] },
      },
    },
    docs: { path: '/docs' },
  },
} as unknown as Manifest;

describe('serviceNamesFor', () => {
  let store: Store;
  let ticketId: number;

  beforeEach(() => {
    store = openStore(':memory:');
    ticketId = createTicket(store, { key: 'K-9', title: 'demo' }).id;
  });

  afterEach(() => store.close());

  it('names a single-service repository by its repo name, unchanged', () => {
    updateTicketFields(store, ticketId, { selectedRepos: ['api'] });
    expect(serviceNamesFor(store, manifest, ticketId)).toEqual(['api']);
  });

  it('names each service of a multi-service repository by its repo/service unit key', () => {
    updateTicketFields(store, ticketId, { selectedRepos: ['web'] });
    expect(serviceNamesFor(store, manifest, ticketId)).toEqual(['web/front', 'web/back']);
  });

  it('omits repositories with no service', () => {
    updateTicketFields(store, ticketId, { selectedRepos: ['api', 'docs', 'web'] });
    expect(serviceNamesFor(store, manifest, ticketId)).toEqual([
      'api',
      'web/front',
      'web/back',
    ]);
  });
});
