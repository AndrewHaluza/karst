import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openStore, type Store } from '../../store/db.js';
import { createTicket } from '../../store/tickets.js';
import { recordShippedPr, updatePrStatus } from '../../store/prs.js';
import { buildDashboardRows, shipMergeableRepos, type DashboardRowsInput } from './stateRows.js';

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

describe('shipMergeableRepos — the sidebar peek reads the same verdict as the dashboard rail', () => {
  const NOW = '2026-10-09T00:00:00.000Z';
  let store: Store;
  let ticketId: number;

  beforeEach(() => {
    store = openStore(':memory:');
    ticketId = createTicket(store, { key: 'K-8', title: 'demo' }).id;
  });

  afterEach(() => store.close());

  it('is empty with no PR', () => {
    expect(shipMergeableRepos(store, ticketId, NOW)).toEqual([]);
  });

  it('lists a repo whose current PR is open and has a url', () => {
    recordShippedPr(store, { ticketId, repo: 'api', number: 4, url: 'https://x/pr/4' });
    expect(shipMergeableRepos(store, ticketId, NOW)).toEqual(['api']);
  });

  it('leaves out a repo whose PR the dashboard panel refuses to merge', () => {
    recordShippedPr(store, { ticketId, repo: 'api', number: 4, url: 'https://x/pr/4' });
    updatePrStatus(store, { ticketId, repo: 'api', url: 'https://x/pr/4', status: 'closed' });
    expect(shipMergeableRepos(store, ticketId, NOW)).toEqual([]);
  });

  it('agrees with buildDashboardRows for the same ticket', () => {
    recordShippedPr(store, { ticketId, repo: 'api', number: 4, url: 'https://x/pr/4' });
    const rows = buildDashboardRows(store, {
      ticketId,
      selectedRepos: ['api'],
      now: NOW,
      isCheckout: () => false,
      isRepoRunnable: () => true,
      baseBranchDefaultFor: () => 'main',
      baseBranchCandidatesFor: () => [],
      repoNameFor: () => undefined,
      serviceKeys: [],
    });
    expect(shipMergeableRepos(store, ticketId, NOW)).toEqual(rows.mergeableRepos);
  });
});
