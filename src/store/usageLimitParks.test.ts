import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openStore, type Store } from './db.js';
import { createTicket } from './tickets.js';
import { setStage } from './stages.js';
import { parkGateStage, clearStageBlock, stageBlock } from './stageBlocks.js';
import { insertOpenPark, listOpenParks, listParks, resolveOpenParks } from './usageLimitParks.js';

describe('usage_limit_parks', () => {
  let store: Store;
  let ticketId: number;
  beforeEach(() => {
    store = openStore(':memory:');
    ticketId = createTicket(store, { key: 'T-UL', title: 'thing' }).id;
  });
  afterEach(() => store.close());

  const payload = (detail = 'usage limit — claude claude-sonnet-5') => ({
    ticketId,
    stage: 'review' as const,
    kind: 'stage-block' as const,
    lane: 'review' as const,
    target: 'repo' as const,
    provider: 'claude',
    model: 'claude-sonnet-5',
    detail,
    keptOutcome: null,
    parkedAt: '2026-10-13T10:00:00.000Z',
  });

  it('records one open park and upserts a re-park on the same key', () => {
    insertOpenPark(store, payload('first'));
    insertOpenPark(store, payload('second'));
    const open = listOpenParks(store, ticketId);
    expect(open).toHaveLength(1);
    expect(open[0]!.detail).toBe('second');
    expect(open[0]!.parkedAt).toBe('2026-10-13T10:00:00.000Z');
    expect(open[0]!.resolvedAt).toBeNull();
  });

  it('distinguishes parks by target and lane', () => {
    insertOpenPark(store, payload());
    insertOpenPark(store, { ...payload(), target: 'other' });
    expect(listOpenParks(store, ticketId)).toHaveLength(2);
  });

  it('resolves open parks and lets a fresh park open again', () => {
    insertOpenPark(store, payload('first'));
    const resolved = resolveOpenParks(store, {
      ticketId,
      stage: 'review',
      resolution: 'cleared',
      at: '2026-10-13T11:00:00.000Z',
    });
    expect(resolved).toBe(1);
    expect(listOpenParks(store, ticketId)).toHaveLength(0);
    expect(listParks(store, ticketId)[0]!.resolution).toBe('cleared');
    // Re-park succeeds (the unique index only constrains OPEN rows).
    insertOpenPark(store, payload('again'));
    expect(listOpenParks(store, ticketId)).toHaveLength(1);
  });

  it('parkGateStage writes the park row in the same transaction as the block', () => {
    parkGateStage(store, {
      ticketId,
      stageKey: 'review',
      kind: 'usage-limit',
      reason: 'usage limit — claude claude-sonnet-5',
      runAt: '2026-10-13T10:00:00.000Z',
      gates: [],
      stageRunId: null,
      park: {
        provider: 'claude',
        model: 'claude-sonnet-5',
        lane: 'review',
        target: 'repo',
        detail: 'usage limit — claude claude-sonnet-5',
        keptOutcome: '["repo2: 2 findings"]',
      },
    });
    expect(stageBlock(store, ticketId, 'review')?.kind).toBe('usage-limit');
    const open = listOpenParks(store, ticketId);
    expect(open).toHaveLength(1);
    expect(open[0]!.provider).toBe('claude');
    expect(open[0]!.keptOutcome).toBe('["repo2: 2 findings"]');
  });

  it('a non-usage-limit park writes no row even when a payload is passed', () => {
    parkGateStage(store, {
      ticketId,
      stageKey: 'review',
      kind: 'nothing-to-run',
      reason: 'nothing',
      runAt: '2026-10-13T10:00:00.000Z',
      gates: [],
      park: {
        provider: 'claude',
        model: null,
        lane: 'review',
        target: null,
        detail: 'x',
        keptOutcome: null,
      },
    });
    expect(listParks(store, ticketId)).toHaveLength(0);
  });

  it('clearStageBlock resolves the open park (the clear seam)', () => {
    parkGateStage(store, {
      ticketId,
      stageKey: 'review',
      kind: 'usage-limit',
      reason: 'usage limit',
      runAt: '2026-10-13T10:00:00.000Z',
      gates: [],
      park: {
        provider: 'claude',
        model: null,
        lane: 'review',
        target: null,
        detail: 'x',
        keptOutcome: null,
      },
    });
    clearStageBlock(store, ticketId, 'review');
    expect(listOpenParks(store, ticketId)).toHaveLength(0);
  });

  it('overwriting blockedKind with another kind resolves the park', () => {
    setStage(store, ticketId, 'review', {
      status: 'running',
      blockedKind: 'usage-limit',
      blockedReason: 'usage limit',
      blockedAt: '2026-10-13T10:00:00.000Z',
    });
    insertOpenPark(store, {
      ticketId,
      stage: 'review',
      kind: 'stage-block',
      lane: null,
      target: null,
      provider: 'claude',
      model: null,
      detail: 'usage limit',
      keptOutcome: null,
      parkedAt: '2026-10-13T10:00:00.000Z',
    });
    setStage(store, ticketId, 'review', {
      blockedKind: 'nothing-to-run',
      blockedReason: 'nothing',
    });
    expect(listOpenParks(store, ticketId)).toHaveLength(0);
  });
});
