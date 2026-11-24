import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const m = vi.hoisted(() => ({
  executeCommand: vi.fn(),
  showWarningMessage: vi.fn(),
  showErrorMessage: vi.fn(),
  runOffer: vi.fn(),
}));
vi.mock('vscode', () => ({
  commands: { executeCommand: m.executeCommand },
  window: { showWarningMessage: m.showWarningMessage, showErrorMessage: m.showErrorMessage },
}));
vi.mock('./interactiveUsageLimitActions.js', () => ({
  makeInteractiveParkActions: () => ({}),
  runInteractiveOffer: m.runOffer,
}));

import { openStore, type Store } from '../../store/db.js';
import { createTicket } from '../../store/tickets.js';
import { dispatchHook, type HookPayload } from '../../hooks/dispatch.js';
import { listOpenParks } from '../../store/usageLimitParks.js';
import { claudeTrailingQuotaText, codexTrailingQuota, quotaTextFromHook } from '../../agent/interactiveQuota.js';
import { createInteractiveUsageLimitBinding } from '../interactiveUsageLimitBinding.js';
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
    m.runOffer.mockReset();
    m.runOffer.mockResolvedValue(undefined);
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

  it('a codex rollout tail with the usage-limit error parks once, provider codex, one offer', () => {
    const sessionId = '33333333-3333-4333-8333-333333333333';
    const line = JSON.stringify({
      timestamp: '2026-08-08T09:00:00.000Z',
      type: 'event_msg',
      payload: {
        type: 'task_complete',
        turn_id: 't1',
        last_agent_message: null,
        error: { message: "You've hit your usage limit. Upgrade to Plus or try again at Aug 8th, 2026 11:06 AM.", codex_error_info: 'usage_limit_exceeded' },
      },
    });
    const text = `${line}\n`;
    expect(codexTrailingQuota(text)?.key).toBe(line);
    const binding = createInteractiveUsageLimitBinding({
      store,
      pick: vi.fn(),
      switchSession: vi.fn(),
      disposeSession: vi.fn(),
      sessionProviderFor: () => 'codex',
      refresh: vi.fn(),
    } as unknown as Parameters<typeof createInteractiveUsageLimitBinding>[0]);
    binding.onCodexRollout(ticketId, sessionId, text);
    binding.onCodexRollout(ticketId, sessionId, text);
    const parks = listOpenParks(store, ticketId);
    expect(parks).toHaveLength(1);
    expect(parks[0]).toMatchObject({ kind: 'interactive', provider: 'codex', sessionId });
    expect(m.runOffer).toHaveBeenCalledTimes(1);
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
    const prose = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'we hit a usage limit and rate limit' }] } });
    record(claudeTrailingQuotaText(prose));
    expect(listOpenParks(store, ticketId)).toHaveLength(0);
    const err = JSON.stringify({ type: 'assistant', isApiErrorMessage: true, message: { content: [{ type: 'text', text: 'Claude usage limit reached' }] } });
    record(claudeTrailingQuotaText(`${prose}\n${err}\n`));
    record(claudeTrailingQuotaText(`${prose}\n${err}\n`));
    expect(listOpenParks(store, ticketId)).toHaveLength(1);
    expect(offer).toHaveBeenCalledTimes(1);
  });
});
