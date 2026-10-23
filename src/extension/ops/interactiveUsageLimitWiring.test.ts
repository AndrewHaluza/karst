import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { openStore, type Store } from '../../store/db.js';
import { createTicket } from '../../store/tickets.js';
import { dispatchHook, type HookPayload } from '../../hooks/dispatch.js';
import { listOpenParks } from '../../store/usageLimitParks.js';
import { claudeTrailingQuotaText, quotaTextFromHook } from '../../agent/interactiveQuota.js';
import { recordInteractiveUsageLimit } from './interactiveUsageLimitOps.js';

const WT = '/repo/.karst/worktrees/x';

function seedWorktree(store: Store, ticketId: number, path: string): void {
  store.db
    .prepare(
      `INSERT INTO worktrees (ticket_id, repo, path, branch, base_ref, deps_mode)
       VALUES (?, 'app', ?, 'karst/x', 'main', 'inherited')`,
    )
    .run(ticketId, path);
}

/** The host's report seam, minus vscode: text -> record. */
describe('interactive usage-limit signal fixtures', () => {
  let store: Store;
  let ticketId: number;
  const offer = vi.fn();
  beforeEach(() => {
    store = openStore(':memory:');
    ticketId = createTicket(store, { key: 'T-W', title: 'w' }).id;
    seedWorktree(store, ticketId, WT);
    offer.mockReset();
  });
  afterEach(() => store.close());

  const viaHook = (provider: 'opencode' | 'opencode2', message: string): void => {
    const onSessionError = (id: number, payload: HookPayload): void => {
      const text = quotaTextFromHook(payload);
      if (text) {
        recordInteractiveUsageLimit(
          { store, offer },
          { ticketId: id, sessionId: payload.session_id ?? 'unknown', provider, model: null, stage: null, text },
        );
      }
    };
    dispatchHook(
      store,
      { hook_event_name: 'session.error', cwd: WT, session_id: 'ses_1', message },
      undefined, undefined, undefined, undefined, undefined, undefined,
      onSessionError,
    );
  };

  it.each(['opencode', 'opencode2'] as const)('%s session.error with quota text parks and offers', (provider) => {
    viaHook(provider, 'Error: insufficient_quota — you exceeded your current quota');
    expect(listOpenParks(store, ticketId)).toHaveLength(1);
    expect(offer).toHaveBeenCalledTimes(1);
  });

  it('a non-quota session.error does not park', () => {
    viaHook('opencode', 'ECONNRESET while streaming');
    expect(listOpenParks(store, ticketId)).toHaveLength(0);
  });

  it('claude transcript ending in an API usage-limit error parks; prose does not', () => {
    const record = (text: string | null): void => {
      if (text) {
        recordInteractiveUsageLimit(
          { store, offer },
          { ticketId, sessionId: 'c1', provider: 'claude', model: null, stage: 'impl', text },
        );
      }
    };
    const prose = JSON.stringify({ message: { content: [{ type: 'text', text: 'we hit a usage limit and rate limit' }] } });
    record(claudeTrailingQuotaText(prose));
    expect(listOpenParks(store, ticketId)).toHaveLength(0);
    const err = JSON.stringify({ isApiErrorMessage: true, message: { content: [{ type: 'text', text: 'Claude usage limit reached' }] } });
    record(claudeTrailingQuotaText(`${prose}\n${err}\n`));
    record(claudeTrailingQuotaText(`${prose}\n${err}\n`));
    expect(listOpenParks(store, ticketId)).toHaveLength(1);
    expect(offer).toHaveBeenCalledTimes(1);
  });
});
