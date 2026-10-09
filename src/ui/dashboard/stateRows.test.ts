import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openStore, type Store } from '../../store/db.js';
import { createTicket } from '../../store/tickets.js';
import { buildDashboardRows, type DashboardRowsInput } from './stateRows.js';

describe('buildDashboardRows env scopes', () => {
  let store: Store;
  let ticketId: number;

  beforeEach(() => {
    store = openStore(':memory:');
    ticketId = createTicket(store, { key: 'K-7', title: 'demo' }).id;
  });

  afterEach(() => store.close());

  function rowsFor(serviceKeys: readonly string[]) {
    const input: DashboardRowsInput = {
      ticketId,
      selectedRepos: ['api', 'web'],
      now: '2026-10-09T00:00:00.000Z',
      isCheckout: () => false,
      isRepoRunnable: () => true,
      baseBranchDefaultFor: () => 'main',
      baseBranchCandidatesFor: () => [],
      repoNameFor: () => undefined,
      serviceKeys,
    };
    return buildDashboardRows(store, input);
  }

  it('lists the injected service unit keys as the env-overridable scopes', () => {
    expect(rowsFor(['api', 'web/front', 'web/back']).envOverrides.services).toEqual([
      'api',
      'web/front',
      'web/back',
    ]);
  });
});
