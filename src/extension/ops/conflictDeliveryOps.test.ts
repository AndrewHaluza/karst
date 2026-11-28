import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { currentConflictDelivery, currentFixDelivery } from '../../store/fixDeliveries.js';
import { setStageCurrent } from '../../store/tickets.js';
import { makeHarness, type Harness } from '../../store/fixtures/fixDeliveryHarness.js';
import { fixPointer, messagePointer } from '../../workflow/messageDelivery.js';
import { deliverLiveFix } from './fixDeliveryOps.js';
import { makeConflictDelivery, type ConflictDeliveryDeps } from './conflictDeliveryOps.js';

const BRIEF = 'Resolve the merge conflict in api: a.ts. ONE LONG BRIEF TEXT';

describe('conflict delivery (@arch:AP-01)', () => {
  let h: Harness;
  const nudge = vi.fn<ConflictDeliveryDeps['nudge']>(() => true);
  const open = vi.fn<ConflictDeliveryDeps['open']>();
  const focus = vi.fn();
  let graph = false;
  beforeEach(() => {
    h = makeHarness();
    setStageCurrent(h.store, h.ticketId, 'ship');
    nudge.mockClear(); open.mockClear(); focus.mockClear(); graph = false;
  });
  afterEach(() => h.store.close());

  const make = () =>
    makeConflictDelivery({
      isLive: () => h.state.live,
      isGraphTicket: () => graph,
      nudge,
      focus,
      open,
      deliverLive: (id, repo, brief) => deliverLiveFix(h.host, { ticketId: id, roundId: null, body: brief, truncatedFooter: '… truncated', kind: 'conflict', repo }),
      recordSeed: () => { throw new Error('a live round records no seed'); },
      key: () => 'K-1',
      debug: vi.fn(),
    });

  it('a live claude session gets a stored conflict snapshot and the pointer route, never the brief text', () => {
    h.state.route = 'hook-block';
    make()(h.ticketId, BRIEF, 'api');
    const row = currentConflictDelivery(h.store, h.ticketId, 'api')!;
    expect(row).toMatchObject({ kind: 'conflict', repo: 'api', body: BRIEF, readAt: null });
    expect(row.armedAt).not.toBeNull();
    expect(nudge).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
    expect(focus).toHaveBeenCalledWith(h.ticketId);
    const line = messagePointer(fixPointer(row.id, 'ship', 'conflict'), 'cli-env');
    expect(line).toContain(`conflict brief #${row.id} ready`);
    expect(line).not.toContain('ONE LONG BRIEF');
    expect(line).not.toContain('stage ship');
  });

  it('a typed-route session gets the pointer typed, not the brief', () => {
    h.state.route = 'typed';
    make()(h.ticketId, BRIEF, 'api');
    expect(h.sent).toHaveLength(1);
    expect(nudge).not.toHaveBeenCalled();
  });

  it('a closed session is seeded with the brief and the seed is the receipt', () => {
    h.state.live = false;
    const recordSeed = vi.fn();
    const deliver = makeConflictDelivery({ ...baseDeps(), recordSeed });
    deliver(h.ticketId, BRIEF, 'api');
    expect(open).toHaveBeenCalledWith(h.ticketId, BRIEF, 'api');
    expect(recordSeed).toHaveBeenCalledWith(h.ticketId, 'api', BRIEF);
    expect(nudge).not.toHaveBeenCalled();
  });

  it('a live session no route can reach falls back to the seed', () => {
    h.state.route = 'typed';
    h.state.sendResult = 'unavailable';
    const recordSeed = vi.fn();
    makeConflictDelivery({ ...baseDeps(), recordSeed })(h.ticketId, BRIEF, 'api');
    expect(open).toHaveBeenCalledTimes(1);
    expect(recordSeed).toHaveBeenCalledTimes(1);
  });

  it('a graph ticket keeps its route: nudge a live session with the brief, else open one', () => {
    graph = true;
    make()(h.ticketId, BRIEF, 'api');
    expect(nudge).toHaveBeenCalledWith(h.ticketId, BRIEF);
    expect(currentFixDelivery(h.store, h.ticketId)).toBeNull();
    nudge.mockReturnValue(false);
    make()(h.ticketId, BRIEF, 'api');
    expect(open).toHaveBeenCalledWith(h.ticketId, BRIEF, 'api');
    expect(currentFixDelivery(h.store, h.ticketId)).toBeNull();
    nudge.mockReturnValue(true);
  });

  it('writes one debug line for each route', () => {
    const debug = vi.fn();
    const deliver = () => makeConflictDelivery({ ...baseDeps(), debug })(h.ticketId, BRIEF, 'api');
    deliver();
    h.state.live = false;
    deliver();
    graph = true;
    deliver();
    nudge.mockReturnValue(false);
    deliver();
    nudge.mockReturnValue(true);
    expect(debug.mock.calls.map((c) => c[0])).toEqual([
      '[ship] ticket K-1: conflict brief stored; the live session is pointed at it',
      '[ship] ticket K-1: conflict brief sent as the seed of a new session',
      '[ship] ticket K-1: conflict brief sent to the live graph session',
      '[ship] ticket K-1: conflict brief sent as the seed of a new graph session',
    ]);
  });

  it('a graph ticket focuses the session after a nudge and not after an open', () => {
    graph = true;
    make()(h.ticketId, BRIEF, 'api');
    expect(focus).toHaveBeenCalledTimes(1);
    nudge.mockReturnValue(false);
    make()(h.ticketId, BRIEF, 'api');
    expect(focus).toHaveBeenCalledTimes(1);
    nudge.mockReturnValue(true);
  });

  describe('async live delivery (D556 mirror)', () => {
    it.each([
      ['resolves true: focus, no seed', () => Promise.resolve(true), true],
      ['resolves false: seed, no focus', () => Promise.resolve(false), false],
      ['rejects: seed, no focus', () => Promise.reject(new Error('mirror down')), false],
    ] as const)('%s', async (_name, deliverLive, focused) => {
      const recordSeed = vi.fn();
      await makeConflictDelivery({ ...baseDeps(), deliverLive, recordSeed })(h.ticketId, BRIEF, 'api');
      expect(focus).toHaveBeenCalledTimes(focused ? 1 : 0);
      expect(open).toHaveBeenCalledTimes(focused ? 0 : 1);
      expect(recordSeed).toHaveBeenCalledTimes(focused ? 0 : 1);
    });
  });

  function baseDeps(): ConflictDeliveryDeps {
    return {
      isLive: () => h.state.live,
      isGraphTicket: () => graph,
      nudge,
      focus,
      open,
      deliverLive: (id, repo, brief) => deliverLiveFix(h.host, { ticketId: id, roundId: null, body: brief, truncatedFooter: '… truncated', kind: 'conflict', repo }),
      recordSeed: vi.fn(),
      key: () => 'K-1',
      debug: vi.fn(),
    };
  }
});
