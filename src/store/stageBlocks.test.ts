import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openStore, type Store } from './db.js';
import { createTicketFlow } from '../workflow/stages/create.js';
import { getTicket } from './tickets.js';
import { transition } from '../workflow/machine.js';
import { listGateRuns } from './gateRuns.js';
import { stageAttempt } from './stages.js';
import { parkGateStage, stageBlock, clearStageBlock } from './stageBlocks.js';

describe('parkGateStage', () => {
  let store: Store;
  let id: number;

  beforeEach(() => {
    store = openStore(':memory:');
    id = createTicketFlow(store, { key: 'T-1', title: 't' }).id;
    transition(store, id, 'scope', { kind: 'passed' });
    transition(store, id, 'impl', { kind: 'passed' });
  });
  afterEach(() => store.close());

  it('persists the blocker without transitioning or consuming an attempt', () => {
    parkGateStage(store, {
      ticketId: id,
      stageKey: 'uat',
      kind: 'nothing-to-run',
      reason: 'no test, test:integration, e2e, test:e2e, cypress or playwright script',
      runAt: '2026-07-30T10:00:00.000Z',
      gates: [],
    });

    const ticket = getTicket(store, id);
    expect(ticket.stageCurrent).toBe('uat');
    const uat = ticket.stages.find((s) => s.stageKey === 'uat')!;
    expect(uat.attempt).toBe(0);
    expect(uat.blockedKind).toBe('nothing-to-run');
    expect(uat.blockedReason).toContain('cypress');
    expect(uat.blockedAt).toBe('2026-07-30T10:00:00.000Z');
  });

  it('files gate evidence under the attempt that ran', () => {
    parkGateStage(store, {
      ticketId: id,
      stageKey: 'uat',
      kind: 'capability-missing',
      reason: 'cannot read package.json: EACCES',
      runAt: '2026-07-30T10:00:00.000Z',
      gates: [{ gateName: 'test', exitCode: null, startedAt: null, endedAt: null }],
    });
    const runs = listGateRuns(store, id);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ stageKey: 'uat', gateName: 'test', attempt: 0 });
  });

  it('commits the block and the evidence together or not at all', () => {
    expect(() =>
      parkGateStage(store, {
        ticketId: id,
        stageKey: 'uat',
        kind: 'nothing-to-run',
        reason: 'x',
        runAt: '2026-07-30T10:00:00.000Z',
        // A gate name of the wrong type forces the INSERT to throw mid-transaction.
        gates: [{ gateName: { bad: true } as unknown as string, exitCode: null, startedAt: null, endedAt: null }],
      }),
    ).toThrow();
    expect(stageBlock(store, id, 'uat')).toBeNull();
    expect(listGateRuns(store, id)).toHaveLength(0);
  });

  it('rolls back an already-written gate row when a later gate in the same batch throws', () => {
    // First gate is well-formed and its INSERT genuinely succeeds; the second
    // is malformed and throws. This is the case a single-gate batch cannot
    // exercise: it proves the transaction actually rolls back a prior write,
    // not just that the throw happens before any write at all.
    expect(() =>
      parkGateStage(store, {
        ticketId: id,
        stageKey: 'uat',
        kind: 'nothing-to-run',
        reason: 'x',
        runAt: '2026-07-30T10:00:00.000Z',
        gates: [
          { gateName: 'test', exitCode: null, startedAt: null, endedAt: null },
          { gateName: { bad: true } as unknown as string, exitCode: null, startedAt: null, endedAt: null },
        ],
      }),
    ).toThrow();

    expect(listGateRuns(store, id)).toHaveLength(0);
    expect(stageBlock(store, id, 'uat')).toBeNull();
    expect(stageAttempt(store, id, 'uat')).toBe(0);
  });

  it('reads back and clears a block', () => {
    parkGateStage(store, {
      ticketId: id, stageKey: 'uat', kind: 'nothing-to-run',
      reason: 'nothing to run', runAt: '2026-07-30T10:00:00.000Z', gates: [],
    });
    expect(stageBlock(store, id, 'uat')).toEqual({
      kind: 'nothing-to-run', reason: 'nothing to run', at: '2026-07-30T10:00:00.000Z',
    });
    clearStageBlock(store, id, 'uat');
    expect(stageBlock(store, id, 'uat')).toBeNull();
  });
});
