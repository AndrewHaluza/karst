import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openStore, type Store } from './db.js';
import { createTicket } from './tickets.js';
import { setStage } from './stages.js';
import { parkGateStage, clearStageBlock, stageBlock } from './stageBlocks.js';
import {
  claimUsageLimitPark,
  insertOpenPark,
  listOpenParks,
  listParks,
  recordUsageLimitOpPark,
  reopenUsageLimitPark,
  resolveOpenParks,
} from './usageLimitParks.js';
import { UsageLimitError } from '../agent/cliFailure.js';

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

  it('keeps the sibling observations when a SECOND park lands on the same key', () => {
    // The first park kept what a sibling target reported before the quota
    // stopped the run. A second park at the same key names only the target it
    // touched — it must NOT erase the sibling's observations.
    const siblingObservation = {
      severity: 'high',
      title: 'Sibling API endpoint returns 500',
      repo: 'api',
      file: 'src/server.ts',
      line: 42,
    };
    insertOpenPark(store, {
      ...payload('first'),
      keptOutcome: JSON.stringify({
        observations: [siblingObservation],
        targets: [
          { repo: 'api', status: 'completed', observations: 1 },
          { repo: 'web', status: 'usage-limited', observations: 0 },
        ],
      }),
    });
    // The second park hit the quota on its FIRST target: it kept nothing.
    insertOpenPark(store, {
      ...payload('second'),
      keptOutcome: JSON.stringify({
        observations: [],
        targets: [{ repo: 'web', status: 'usage-limited', observations: 0 }],
      }),
    });

    const open = listOpenParks(store, ticketId);
    expect(open).toHaveLength(1);
    const kept = JSON.parse(open[0]!.keptOutcome!) as {
      observations: { repo: string; title: string }[];
      targets: { repo: string; status: string }[];
    };
    expect(kept.observations).toEqual([siblingObservation]);
    // The sibling target's entry survives; the re-parked target keeps its fresh
    // (usage-limited) status.
    expect(kept.targets).toEqual([
      { repo: 'api', status: 'completed', observations: 1 },
      { repo: 'web', status: 'usage-limited', observations: 0 },
    ]);
  });

  it('keeps the prior kept outcome when a re-park carries none (and vice versa)', () => {
    const prior = JSON.stringify({
      observations: [{ severity: 'high', title: 'kept', repo: 'api' }],
      targets: [{ repo: 'api', status: 'completed', observations: 1 }],
    });
    insertOpenPark(store, { ...payload('first'), keptOutcome: prior });
    // A re-park with no kept outcome keeps the evidence the row already had.
    insertOpenPark(store, { ...payload('second'), keptOutcome: null });
    expect(JSON.parse(listOpenParks(store, ticketId)[0]!.keptOutcome!).observations).toHaveLength(1);

    // A malformed kept outcome never erases a readable one.
    insertOpenPark(store, { ...payload('third'), keptOutcome: 'not json' });
    expect(JSON.parse(listOpenParks(store, ticketId)[0]!.keptOutcome!).observations).toHaveLength(1);

    // A malformed PRIOR is replaced by the readable fresh outcome.
    const other = createTicket(store, { key: 'T-UL-OTHER', title: 'other' }).id;
    insertOpenPark(store, { ...payload('fourth'), ticketId: other, keptOutcome: 'not json' });
    const fresh = JSON.stringify({
      observations: [{ severity: 'low', title: 'fresh', repo: 'web' }],
      targets: [{ repo: 'web', status: 'usage-limited', observations: 1 }],
    });
    insertOpenPark(store, { ...payload('fifth'), ticketId: other, keptOutcome: fresh });
    expect(JSON.parse(listOpenParks(store, other)[0]!.keptOutcome!).observations).toHaveLength(1);
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

  it('records an op park from a quota error and ignores every other failure (K11)', () => {
    const limit = new UsageLimitError('Claude usage limit reached — out of credits.', {
      tool: 'Claude',
      provider: 'claude',
      model: 'claude-sonnet-5',
    });
    expect(recordUsageLimitOpPark(store, limit, { ticketId, stage: 'fix' })).not.toBeNull();
    const open = listOpenParks(store, ticketId);
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({
      kind: 'op',
      stage: 'fix',
      lane: null,
      provider: 'claude',
      model: 'claude-sonnet-5',
    });

    // A non-quota error records nothing, and a repeat collapses to one open row.
    expect(recordUsageLimitOpPark(store, new Error('boom'), { ticketId, stage: 'fix' })).toBeNull();
    recordUsageLimitOpPark(store, limit, { ticketId, stage: 'fix' });
    expect(listOpenParks(store, ticketId)).toHaveLength(1);
  });

  it('keeps two different ops at one stage as separate open parks, keyed by `lane` (D159)', () => {
    const limit = new UsageLimitError('Claude usage limit reached — out of credits.', {
      tool: 'Claude',
      provider: 'claude',
      model: 'claude-sonnet-5',
    });
    // The ticket form records the analysis op and the signal-suggest op at the
    // SAME stage; without the discriminator the second would overwrite the first.
    recordUsageLimitOpPark(store, limit, { ticketId, stage: 'scope', lane: 'analysis' });
    recordUsageLimitOpPark(store, limit, {
      ticketId,
      stage: 'scope',
      lane: 'suggest',
      target: 'fe',
    });

    const open = listOpenParks(store, ticketId);
    expect(open).toHaveLength(2);
    expect(open.map((p) => p.lane).sort()).toEqual(['analysis', 'suggest']);
    // Re-recording one op still collapses onto its own row.
    recordUsageLimitOpPark(store, limit, { ticketId, stage: 'scope', lane: 'analysis' });
    expect(listOpenParks(store, ticketId)).toHaveLength(2);
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
    setStage(
      store,
      ticketId,
      'review',
      { blockedKind: 'nothing-to-run', blockedReason: 'nothing' },
      { parkResolution: 'superseded', parkResolvedAt: '2026-10-13T12:34:56.000Z' },
    );
    expect(listOpenParks(store, ticketId)).toHaveLength(0);
    // The clear seam takes the time (and resolution) from the caller, so a test
    // can pin them; it never reads the wall clock for a resolved park.
    const resolved = listParks(store, ticketId)[0]!;
    expect(resolved.resolvedAt).toBe('2026-10-13T12:34:56.000Z');
    expect(resolved.resolution).toBe('superseded');
  });

  describe('claimUsageLimitPark', () => {
    it('claims an open stage-block park and clears the stage block atomically', () => {
      setStage(store, ticketId, 'review', {
        status: 'running',
        blockedKind: 'usage-limit',
        blockedReason: 'usage limit',
        blockedAt: '2026-10-13T10:00:00.000Z',
      });
      const parkId = insertOpenPark(store, payload('test-claim'));
      const res = claimUsageLimitPark(store, parkId, 'pick', '2026-10-13T12:00:00.000Z');

      expect(res.claimed).toBe(true);
      expect(res.park).not.toBeNull();
      expect(res.park?.id).toBe(parkId);
      expect(res.park?.resolution).toBe('pick');
      expect(res.park?.resolvedAt).toBe('2026-10-13T12:00:00.000Z');

      // The stage block is now cleared
      const block = stageBlock(store, ticketId, 'review');
      expect(block).toBeNull();
      // No open parks remain
      expect(listOpenParks(store, ticketId)).toHaveLength(0);
    });

    it('refuses claim when the park row is already resolved (concurrent claim race)', () => {
      setStage(store, ticketId, 'review', {
        status: 'running',
        blockedKind: 'usage-limit',
        blockedReason: 'usage limit',
        blockedAt: '2026-10-13T10:00:00.000Z',
      });
      const parkId = insertOpenPark(store, payload('test-claim-race'));
      const first = claimUsageLimitPark(store, parkId, 'pick', '2026-10-13T12:00:00.000Z');
      expect(first.claimed).toBe(true);

      // Second claim sees already resolved
      const second = claimUsageLimitPark(store, parkId, 'retry', '2026-10-13T12:01:00.000Z');
      expect(second.claimed).toBe(false);
      expect(second.park).toBeNull();
    });

    it('refuses claim when the stage block was replaced or cleared concurrently', () => {
      setStage(store, ticketId, 'review', {
        status: 'running',
        blockedKind: 'usage-limit',
        blockedReason: 'usage limit',
        blockedAt: '2026-10-13T10:00:00.000Z',
      });
      const parkId = insertOpenPark(store, payload('test-stage-race'));

      // Concurrently, e.g. sendBack or retryGate replaced or cleared the block
      setStage(store, ticketId, 'review', {
        blockedKind: 'nothing-to-run',
        blockedReason: 'nothing',
      });

      // Now attempting to claim must abort because stage is not blocked on usage-limit
      const res = claimUsageLimitPark(store, parkId, 'pick', '2026-10-13T12:00:00.000Z');
      expect(res.claimed).toBe(false);
      expect(res.park).toBeNull();
    });

    it('claims an op park without touching stage blocks', () => {
      const parkId = insertOpenPark(store, {
        ticketId,
        stage: 'scope',
        kind: 'op',
        lane: null,
        target: null,
        provider: 'claude',
        model: null,
        detail: 'quota exceeded',
        keptOutcome: null,
        parkedAt: '2026-10-13T10:00:00.000Z',
      });
      const res = claimUsageLimitPark(store, parkId, 'dismiss', '2026-10-13T12:00:00.000Z');
      expect(res.claimed).toBe(true);
      expect(res.park?.resolution).toBe('dismiss');
      expect(listOpenParks(store, ticketId)).toHaveLength(0);
    });
  });

  describe('reopenUsageLimitPark', () => {
    it('re-opens a claimed stage-block park and re-blocks its stage', () => {
      setStage(store, ticketId, 'review', {
        status: 'running',
        blockedKind: 'usage-limit',
        blockedReason: 'out of credits',
        blockedAt: '2026-10-13T10:00:00.000Z',
      });
      const parkId = insertOpenPark(store, payload('out of credits'));
      claimUsageLimitPark(store, parkId, 'pick', '2026-10-13T12:00:00.000Z');
      expect(stageBlock(store, ticketId, 'review')).toBeNull();

      // The run that claimed it never reached a verdict: put it back.
      const reopened = reopenUsageLimitPark(store, parkId, {
        reason: 'usage limit — claude claude-sonnet-5',
        at: '2026-10-13T12:05:00.000Z',
      });

      expect(reopened).toBe(true);
      const open = listOpenParks(store, ticketId);
      expect(open).toHaveLength(1);
      expect(open[0]?.id).toBe(parkId);
      expect(open[0]?.resolution).toBeNull();
      expect(open[0]?.resolvedAt).toBeNull();
      expect(stageBlock(store, ticketId, 'review')).toEqual({
        kind: 'usage-limit',
        reason: 'usage limit — claude claude-sonnet-5',
        at: '2026-10-13T12:05:00.000Z',
      });
    });

    it('falls back to the park diagnostic when no reason is given', () => {
      setStage(store, ticketId, 'review', { blockedKind: 'usage-limit', blockedReason: 'x' });
      const parkId = insertOpenPark(store, payload('monthly quota exceeded'));
      claimUsageLimitPark(store, parkId, 'retry', '2026-10-13T12:00:00.000Z');

      reopenUsageLimitPark(store, parkId, { at: '2026-10-13T12:05:00.000Z' });

      expect(stageBlock(store, ticketId, 'review')?.reason).toBe('monthly quota exceeded');
    });

    it('re-opens an OP park without touching any stage block', () => {
      const parkId = insertOpenPark(store, {
        ticketId,
        stage: 'scope',
        kind: 'op',
        lane: 'classify',
        target: null,
        provider: 'claude',
        model: null,
        detail: 'quota exceeded',
        keptOutcome: null,
        parkedAt: '2026-10-13T10:00:00.000Z',
      });
      claimUsageLimitPark(store, parkId, 'dismiss', '2026-10-13T12:00:00.000Z');

      expect(reopenUsageLimitPark(store, parkId)).toBe(true);
      expect(listOpenParks(store, ticketId)).toHaveLength(1);
      expect(stageBlock(store, ticketId, 'scope')).toBeNull();
    });

    it('leaves a park that is still open alone', () => {
      const parkId = insertOpenPark(store, payload('still open'));

      expect(reopenUsageLimitPark(store, parkId)).toBe(false);
      expect(listOpenParks(store, ticketId)).toHaveLength(1);
    });
  });
});
