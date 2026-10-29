import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { openStore, type Store } from '../../store/db.js';
import { createTicketFlow } from '../../workflow/stages/create.js';
import { transition } from '../../workflow/machine.js';
import { getTicket } from '../../store/tickets.js';
import { stageBlock } from '../../store/stageBlocks.js';
import { listRecoveryRounds } from '../../store/recoveryRounds.js';
import { reviewStallHint } from '../../store/reviewStallHint.js';
import { reviewStallAttempts } from '../../workflow/reviewStallRead.js';
import { setStage } from '../../store/stages.js';
import { redesignHintAction, continueAnywayAction, type ReviewStallActionDeps } from './reviewStallActions.js';

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('review stall actions', () => {
  let store: Store;
  let id: number;
  let deps: ReviewStallActionDeps;
  beforeEach(() => {
    store = openStore(':memory:');
    id = createTicketFlow(store, { key: 'T-1', title: 't' }).id;
    transition(store, id, 'scope', { kind: 'passed' });
    transition(store, id, 'impl', { kind: 'passed' });
    transition(store, id, 'uat', { kind: 'passed' });
    transition(store, id, 'review', { kind: 'failed', reason: 'review findings' });
    setStage(store, id, 'fix', {
      status: 'failed', blockedKind: 'review-stalled', blockedReason: 'r', blockedAt: 'x',
    });
    deps = {
      store, ticketId: id, afterServerChange: vi.fn(), logError: vi.fn(), debug: vi.fn(),
      drive: vi.fn(), info: vi.fn(), error: vi.fn(),
      confirm: vi.fn(async () => true), promptHint: vi.fn(async () => 'split the module'),
      now: () => '2026-01-01T00:00:00.000Z',
    };
  });
  afterEach(() => store.close());

  it('continue anyway clears the block, resumes review and drives', async () => {
    continueAnywayAction(deps);
    await flush();
    expect(stageBlock(store, id, 'fix')).toBeNull();
    expect(getTicket(store, id).stageCurrent).toBe('review');
    expect(deps.drive).toHaveBeenCalled();
    expect(deps.afterServerChange).toHaveBeenCalled();
    expect(reviewStallAttempts(store, id, 'high')).toEqual([]);
  });
  it('continue anyway does nothing when not confirmed', async () => {
    deps.confirm = vi.fn(async () => false);
    continueAnywayAction(deps);
    await flush();
    expect(getTicket(store, id).stageCurrent).toBe('fix');
    expect(deps.drive).not.toHaveBeenCalled();
  });
  it('redesign hint stores the note, resets and drives', async () => {
    redesignHintAction(deps);
    await flush();
    expect(reviewStallHint(store, id)).toBe('split the module');
    expect(getTicket(store, id).stageCurrent).toBe('review');
    expect(listRecoveryRounds(store, id).every((r) => r.status !== 'pending')).toBe(true);
    expect(deps.drive).toHaveBeenCalled();
  });
  it('a cancelled hint prompt changes nothing', async () => {
    deps.promptHint = vi.fn(async () => undefined);
    redesignHintAction(deps);
    await flush();
    expect(reviewStallHint(store, id)).toBeNull();
    expect(getTicket(store, id).stageCurrent).toBe('fix');
  });
  it('refuses when the ticket is not stalled', async () => {
    setStage(store, id, 'fix', { blockedKind: null, blockedReason: null, blockedAt: null });
    continueAnywayAction(deps);
    await flush();
    expect(deps.info).toHaveBeenCalled();
    expect(deps.drive).not.toHaveBeenCalled();
  });
});
