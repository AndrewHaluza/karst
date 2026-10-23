import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { openStore, type Store } from '../../store/db.js';
import { createTicket } from '../../store/tickets.js';
import { listOpenParks, listParks } from '../../store/usageLimitParks.js';
import type { AgentSwitchOutcome } from '../../agent/sessionSwitch.js';
import { recordInteractiveUsageLimit } from './interactiveUsageLimitOps.js';
import { makeInteractiveParkActions, runInteractiveOffer, PICK_LABEL, RETRY_LABEL, DISMISS_LABEL } from './interactiveUsageLimitActions.js';

describe('interactive park actions', () => {
  let store: Store;
  let ticketId: number;
  let parkId: number;
  const pick = vi.fn();
  const switchSession = vi.fn();
  const relaunch = vi.fn();
  const actions = () => makeInteractiveParkActions({ store, pick, switchSession, relaunch });

  beforeEach(() => {
    store = openStore(':memory:');
    ticketId = createTicket(store, { key: 'T-IA', title: 'thing' }).id;
    parkId = recordInteractiveUsageLimit(
      { store, offer: () => undefined },
      { ticketId, sessionId: 's1', provider: 'claude', model: 'm1', stage: 'impl', text: 'Claude usage limit reached' },
    )!;
    pick.mockReset().mockResolvedValue({ provider: 'codex', model: 'gpt-x' });
    switchSession.mockReset().mockResolvedValue({ kind: 'switched' } satisfies AgentSwitchOutcome);
    relaunch.mockReset().mockResolvedValue(undefined);
  });
  afterEach(() => store.close());

  it('Pick -> switched claims the row with the switched resolution', async () => {
    expect(await actions().pickAgent(ticketId, parkId)).toBe('switched');
    expect(switchSession).toHaveBeenCalledWith(ticketId, { provider: 'codex', model: 'gpt-x' });
    expect(listOpenParks(store, ticketId)).toHaveLength(0);
    expect(listParks(store, ticketId)[0]?.resolution).toBe('switched:codex/gpt-x');
  });

  it.each<AgentSwitchOutcome>([
    { kind: 'stale' },
    { kind: 'unavailable', provider: 'codex' },
    { kind: 'cancelled', at: 'confirm' },
    { kind: 'launch-failed', error: new Error('x') },
  ])('Pick -> $kind leaves the row open', async (outcome) => {
    switchSession.mockResolvedValue(outcome);
    expect(await actions().pickAgent(ticketId, parkId)).toBe('open');
    expect(listOpenParks(store, ticketId)).toHaveLength(1);
  });

  it('dismissed picker leaves the row open and never switches', async () => {
    pick.mockResolvedValue(undefined);
    expect(await actions().pickAgent(ticketId, parkId)).toBe('open');
    expect(switchSession).not.toHaveBeenCalled();
  });

  it('a second Pick after the claim finds nothing', async () => {
    await actions().pickAgent(ticketId, parkId);
    expect(await actions().pickAgent(ticketId, parkId)).toBe('gone');
    expect(switchSession).toHaveBeenCalledTimes(1);
  });

  it('Retry same relaunches, claims retry, never picks or switches', async () => {
    expect(await actions().retrySame(ticketId, parkId)).toBe('retried');
    expect(relaunch).toHaveBeenCalledWith(ticketId);
    expect(pick).not.toHaveBeenCalled();
    expect(switchSession).not.toHaveBeenCalled();
    expect(listParks(store, ticketId)[0]?.resolution).toBe('retry');
  });

  it('Retry same on a claimed row does nothing', async () => {
    await actions().retrySame(ticketId, parkId);
    expect(await actions().retrySame(ticketId, parkId)).toBe('gone');
    expect(relaunch).toHaveBeenCalledTimes(1);
  });

  describe('runInteractiveOffer', () => {
    const run = (answers: Array<string | undefined>) => {
      const ask = vi.fn();
      for (const a of answers) ask.mockResolvedValueOnce(a);
      return { ask, done: runInteractiveOffer({ store, ticketId, parkId, actions: actions(), ask }) };
    };

    it('re-asks after a Pick that did not switch, then retries', async () => {
      switchSession.mockResolvedValueOnce({ kind: 'cancelled', at: 'confirm' });
      const { ask, done } = run([PICK_LABEL, RETRY_LABEL]);
      await done;
      expect(ask).toHaveBeenCalledTimes(2);
      expect(listParks(store, ticketId)[0]?.resolution).toBe('retry');
    });

    it('Dismiss resolves the row without acting', async () => {
      await run([DISMISS_LABEL]).done;
      expect(listParks(store, ticketId)[0]?.resolution).toBe('dismissed');
      expect(relaunch).not.toHaveBeenCalled();
    });

    it('closing the prompt leaves the row open', async () => {
      await run([undefined]).done;
      expect(listOpenParks(store, ticketId)).toHaveLength(1);
    });
  });
});
