import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openStore, type Store } from '../store/db.js';
import { createTicket, getTicket } from '../store/tickets.js';
import { getStage, setStage } from '../store/stages.js';
import { parkGateStage, stageBlock } from '../store/stageBlocks.js';
import { ticketsToSweep } from './driverController.js';
import { openRecoveryRound } from '../store/recoveryRounds.js';
import { retryGateState, retryGateStage } from './retryGate.js';

/**
 * The dashboard's "Retry gate" control. A park records only the block and
 * leaves the stage row `running` (a park is not a transition), which used to
 * make the eligibility check call every blocked stage in-flight — the control
 * never enabled and the gate could never be re-run.
 */
describe('retryGateState / retryGateStage', () => {
  let store: Store;
  beforeEach(() => (store = openStore(':memory:')));
  afterEach(() => store.close());

  function atGateStage(key: string, stage: 'uat' | 'review'): number {
    const t = createTicket(store, { key, title: 'thing' });
    store.db.prepare('UPDATE tickets SET stage_current = ? WHERE id = ?').run(stage, t.id);
    // A run in progress stamps `running` at its start; the park below leaves it.
    setStage(store, t.id, stage, { status: 'running' });
    return t.id;
  }

  function park(store: Store, id: number, stage: 'uat' | 'review'): void {
    parkGateStage(store, {
      ticketId: id,
      stageKey: stage,
      kind: 'nothing-to-run',
      reason: 'no test, test:integration, e2e, test:e2e, cypress or playwright script',
      runAt: '2026-07-30T10:00:00.000Z',
      gates: [],
    });
  }

  it('enables retry for a PARKED gate even though its row still reads running', () => {
    const id = atGateStage('RG-1', 'uat');
    park(store, id, 'uat');
    expect(getStage(store, id, 'uat')?.status).toBe('running');
    expect(stageBlock(store, id, 'uat')?.kind).toBe('nothing-to-run');
    expect(retryGateState(store, id)).toEqual({ available: true, stage: 'uat' });
  });

  it('refuses while the gate is genuinely in-flight (running with no block)', () => {
    const id = atGateStage('RG-2', 'review');
    expect(retryGateState(store, id)).toEqual({ available: false, reason: 'in-flight' });
  });

  it('refuses when the ticket is not at a gate stage', () => {
    const t = createTicket(store, { key: 'RG-3', title: 'thing' });
    store.db.prepare("UPDATE tickets SET stage_current = 'ship' WHERE id = ?").run(t.id);
    expect(retryGateState(store, t.id)).toEqual({ available: false, reason: 'not-gate-stage' });
  });

  it('retries a parked stage and clears the block so the drive sweep re-selects it', () => {
    const id = atGateStage('RG-4', 'uat');
    park(store, id, 'uat');
    // The sweep skips any gate stage still carrying a block — a retry that left
    // the park in place would re-arm nothing.
    expect(ticketsToSweep([getTicket(store, id)])).toEqual([]);

    expect(retryGateStage(store, id, 'uat')).toEqual({ ok: true });
    expect(stageBlock(store, id, 'uat')).toBeNull();
    expect(ticketsToSweep([getTicket(store, id)])).toEqual([id]);
  });

  it('refuses to retry a stage that is genuinely in-flight', () => {
    const id = atGateStage('RG-5', 'review');
    expect(retryGateStage(store, id, 'review')).toEqual({
      ok: false,
      reason: 'stage is in-flight',
    });
  });
});

describe('retryGateState / retryGateStage on a parked fix round', () => {
  let store: Store;
  let ticketId: number;
  beforeEach(() => {
    store = openStore(':memory:');
    ticketId = createTicket(store, { key: 'RG-F', title: 't' }).id;
  });
  afterEach(() => store.close());

  const park = (status = 'interrupted'): void => {
    const id = openRecoveryRound(store, {
      ticketId, sourceStage: 'uat', sourceProcessId: 'gates', triggerKind: 'gate-failure',
      triggerDetail: 'x', maxRounds: 3, startedAt: '2026-01-01T00:00:00Z',
    } as never).id;
    store.db.prepare('UPDATE recovery_rounds SET status = ? WHERE id = ?').run(status, id);
    setStage(store, ticketId, 'fix', { status: 'failed', verdict: 'parked' });
    store.db.prepare("UPDATE tickets SET stage_current = 'fix' WHERE id = ?").run(ticketId);
  };

  it('is available in the fix stage when the round is parked, for the source stage', () => {
    park();
    expect(retryGateState(store, ticketId)).toEqual({ available: true, stage: 'uat', fromFix: true });
  });

  it('stays not-gate-stage for an exhausted round', () => {
    park('exhausted');
    expect(retryGateState(store, ticketId)).toEqual({ available: false, reason: 'not-gate-stage' });
  });

  it('retryGateStage from a parked fix returns the ticket to the source stage', () => {
    park();
    expect(retryGateStage(store, ticketId, 'uat')).toEqual({ ok: true });
    expect(getTicket(store, ticketId).stageCurrent).toBe('uat');
  });

  it('retryGateStage refuses a stage that is not the round source', () => {
    park();
    expect(retryGateStage(store, ticketId, 'review')).toMatchObject({ ok: false });
    expect(getTicket(store, ticketId).stageCurrent).toBe('fix');
  });
});
