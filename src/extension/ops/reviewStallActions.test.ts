import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { openStore, type Store } from '../../store/db.js';
import { createTicketFlow } from '../../workflow/stages/create.js';
import { transition } from '../../workflow/machine.js';
import { getTicket } from '../../store/tickets.js';
import { stageBlock } from '../../store/stageBlocks.js';
import { listRecoveryRounds } from '../../store/recoveryRounds.js';
import { listFindings } from '../../store/reviewFindings.js';
import { reviewStallHint } from '../../store/reviewStallHint.js';
import { reviewStallAttempts } from '../../workflow/reviewStallRead.js';
import { setStage, stageAttempt } from '../../store/stages.js';
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
  it('names the ticket when it is not stalled', async () => {
    setStage(store, id, 'fix', { blockedKind: null, blockedReason: null, blockedAt: null });
    redesignHintAction(deps);
    await flush();
    expect(deps.info).toHaveBeenCalledWith(expect.stringMatching(/^Ticket .+ is not parked on a review stall\.$/));
    expect(deps.promptHint).not.toHaveBeenCalled();
    expect(deps.afterServerChange).toHaveBeenCalled();
  });
  it('trims the hint and records it under the review attempt at the given time', async () => {
    deps.promptHint = vi.fn(async () => '  split it  ');
    const attemptBefore = stageAttempt(store, id, 'review');
    redesignHintAction(deps);
    await flush();
    const hint = listFindings(store, id).find((f) => f.title === 'Redesign hint');
    expect(hint).toMatchObject({ detail: 'split it', source: 'human', severity: 'info', runAt: '2026-01-01T00:00:00.000Z' });
    expect(hint!.attempt).toBe(attemptBefore);
  });
  it('a blank hint changes nothing', async () => {
    deps.promptHint = vi.fn(async () => '   ');
    redesignHintAction(deps);
    await flush();
    expect(deps.promptHint).toHaveBeenCalled();
    expect(getTicket(store, id).stageCurrent).toBe('fix');
    expect(deps.drive).not.toHaveBeenCalled();
  });
  it('continue anyway asks with its title and detail and records no hint', async () => {
    continueAnywayAction(deps);
    await flush();
    expect(deps.confirm).toHaveBeenCalledWith(
      'Continue anyway?',
      expect.stringContaining('Resets the stall counter'),
    );
    expect(listFindings(store, id).some((f) => f.title === 'Redesign hint')).toBe(false);
  });
  it('passes debug through to the reset', async () => {
    continueAnywayAction(deps);
    await flush();
    expect(deps.debug).toHaveBeenCalled();
  });
  it('uses the real clock when none is injected', async () => {
    deps.now = undefined;
    redesignHintAction(deps);
    await flush();
    const hint = listFindings(store, id).find((f) => f.title === 'Redesign hint');
    expect(hint!.runAt).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(hint!.runAt).not.toBe('2026-01-01T00:00:00.000Z');
  });
  it.each([
    ['an Error', new Error('boom'), 'boom'],
    ['a string', 'plain', 'plain'],
  ])('reports %s thrown while resuming, and still refreshes', async (_n, thrown, text) => {
    deps.drive = vi.fn(() => { throw thrown; });
    continueAnywayAction(deps);
    await flush();
    expect(deps.logError).toHaveBeenCalledWith('review stall action failed', thrown);
    expect(deps.error).toHaveBeenCalledWith(expect.stringMatching(new RegExp(`^Could not resume ticket .+: ${text}$`)));
    expect(deps.afterServerChange).toHaveBeenCalled();
  });
});
