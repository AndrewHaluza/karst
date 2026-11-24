import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setStageCurrent } from '../../store/tickets.js';
import { setMergeCheck } from '../../store/mergeChecks.js';
import { getFixDelivery, currentConflictDelivery, currentFixDelivery, claimArmed, claimPointed, claimPointerFailed, claimRead, upsertFixDelivery } from '../../store/fixDeliveries.js';
import { recordSessionLaunchIntent } from '../../store/sessionLaunchIntents.js';
import { closeStaleDeliveries, ackFixDeliveryRef, deliverLiveFix, eligibleFixDelivery, failPointer, sendTypedPointer } from './fixDeliveryOps.js';
import { makeHarness, type Harness } from '../../store/fixtures/fixDeliveryHarness.js';

describe('fixDeliveryOps', () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
  });
  afterEach(() => h.store.close());

  const input = (over: Partial<Parameters<typeof deliverLiveFix>[1]> = {}) => ({
    ticketId: h.ticketId,
    roundId: null,
    body: 'BRIEF',
    truncatedFooter: 'FOOT',
    ...over,
  });

  describe('closeStaleDeliveries', () => {
    it('a stale unread conflict row never holds the pointer of a later fix row', () => {
      const conflict = upsertFixDelivery(h.store, { ticketId: h.ticketId, recoveryRoundId: null, launchId: 'L1', body: 'C', at: h.host.now(), kind: 'conflict', repo: 'api' });
      claimArmed(h.store, conflict, h.host.now());
      setMergeCheck(h.store, { ticketId: h.ticketId, repo: 'api', state: 'clean', files: [], reason: null, headSha: 'h', baseSha: 'b', baseRef: 'main', checkedAt: 'x' });
      expect(deliverLiveFix(h.host, input())).toBe(true);
      const fix = currentFixDelivery(h.store, h.ticketId)!;
      expect(eligibleFixDelivery(h.host, h.ticketId)?.id).toBe(fix.id);
      expect(getFixDelivery(h.store, conflict)?.supersededAt).not.toBeNull();
    });
  });

  describe('closeStaleDeliveries (transient and failed rows)', () => {
    const check = (state: 'unknown' | 'clean'): void =>
      setMergeCheck(h.store, { ticketId: h.ticketId, repo: 'api', state, files: [], reason: null, headSha: 'h', baseSha: 'b', baseRef: 'main', checkedAt: 'x' });
    it('a transient unknown or missing check keeps an unread conflict row; a clean check closes it', () => {
      const id = upsertFixDelivery(h.store, { ticketId: h.ticketId, recoveryRoundId: null, launchId: 'L1', body: 'C', at: h.host.now(), kind: 'conflict', repo: 'api' });
      check('unknown');
      closeStaleDeliveries(h.host, h.ticketId);
      expect(getFixDelivery(h.store, id)?.supersededAt).toBeNull();
      check('clean');
      closeStaleDeliveries(h.host, h.ticketId);
      expect(getFixDelivery(h.store, id)?.supersededAt).not.toBeNull();
    });

    it('a pointer-failed conflict row does not hold the hook pointer of a later fix row', () => {
      const failed = upsertFixDelivery(h.store, { ticketId: h.ticketId, recoveryRoundId: null, launchId: 'L1', body: 'C', at: h.host.now(), kind: 'conflict', repo: 'api' });
      claimArmed(h.store, failed, h.host.now());
      claimPointerFailed(h.store, failed, h.host.now());
      check('unknown');
      expect(deliverLiveFix(h.host, input())).toBe(true);
      const fix = currentFixDelivery(h.store, h.ticketId)!;
      expect(eligibleFixDelivery(h.host, h.ticketId)?.id).toBe(fix.id);
    });
  });

  describe('closeStaleDeliveries (fix row)', () => {
    it('an old unread fix row from a finished round never holds the pointer of a later conflict row', () => {
      const old = upsertFixDelivery(h.store, { ticketId: h.ticketId, recoveryRoundId: null, launchId: 'L1', body: 'F', at: h.host.now() });
      claimArmed(h.store, old, h.host.now());
      setStageCurrent(h.store, h.ticketId, 'ship');
      setMergeCheck(h.store, { ticketId: h.ticketId, repo: 'api', state: 'conflicted', files: ['a.ts'], reason: null, headSha: 'h', baseSha: 'b', baseRef: 'main', checkedAt: 'x' });
      expect(deliverLiveFix(h.host, input({ kind: 'conflict', repo: 'api', body: 'C' }))).toBe(true);
      const conflict = currentConflictDelivery(h.store, h.ticketId, 'api')!;
      expect(eligibleFixDelivery(h.host, h.ticketId)?.id).toBe(conflict.id);
      expect(getFixDelivery(h.store, old)?.supersededAt).not.toBeNull();
    });
  });

  describe('deliverLiveFix', () => {
    it('a tracked round updated in place still delivers when a younger conflict row exists', () => {
      const round = h.openRound();
      expect(deliverLiveFix(h.host, input({ roundId: round }))).toBe(true);
      upsertFixDelivery(h.store, { ticketId: h.ticketId, recoveryRoundId: null, launchId: 'L1', body: 'C', at: h.host.now(), kind: 'conflict', repo: 'api' });
      expect(deliverLiveFix(h.host, input({ roundId: round, body: 'BRIEF 2' }))).toBe(true);
    });

    it('push route: stores the snapshot against the live generation and arms it', () => {
      expect(deliverLiveFix(h.host, input())).toBe(true);
      const row = currentFixDelivery(h.store, h.ticketId)!;
      expect(row).toMatchObject({ body: 'BRIEF', launchId: 'L1', enqueuedAt: null, pointedAt: null });
      expect(row.armedAt).not.toBeNull();
      expect(h.sent).toEqual([]);
    });

    it('stores a NULL launch id when no generation is tracked', () => {
      h.state.launchId = undefined;
      deliverLiveFix(h.host, input());
      expect(currentFixDelivery(h.store, h.ticketId)!.launchId).toBeNull();
    });

    it('push route, idle: arms and types the pointer in the same call', () => {
      h.state.idle = true;
      expect(deliverLiveFix(h.host, input())).toBe(true);
      const row = currentFixDelivery(h.store, h.ticketId)!;
      expect(row.armedAt).not.toBeNull();
      expect(row.enqueuedAt).not.toBeNull();
      expect(row.pointedAt).toBeNull();
      expect(h.sent).toHaveLength(1);
      expect(h.sent[0]!.deliveryId).toBe(row.id);
      const lines = vi.mocked(h.host.debug).mock.calls.map((c) => String(c[0]));
      expect(
        lines.some(
          (l) =>
            l.includes(`fix delivery #${row.id}`) &&
            l.includes(`ticket ${h.ticketId}`) &&
            l.includes('idle push session') &&
            l.includes('immediate pointer queued'),
        ),
      ).toBe(true);
      h.sent[0]!.hooks.onTyped!();
      expect(getFixDelivery(h.store, row.id)!.pointedAt).not.toBeNull();
    });

    it('push route, running: arms only, nothing typed', () => {
      h.state.running = true;
      h.state.idle = false;
      expect(deliverLiveFix(h.host, input())).toBe(true);
      const row = currentFixDelivery(h.store, h.ticketId)!;
      expect(row.armedAt).not.toBeNull();
      expect(row.enqueuedAt).toBeNull();
      expect(h.sent).toEqual([]);
    });

    it.each(['waiting', 'none', 'not-started'] as const)('push route, %s (not running, not idle): arms only', () => {
      h.state.running = false;
      h.state.idle = false;
      expect(deliverLiveFix(h.host, input())).toBe(true);
      const row = currentFixDelivery(h.store, h.ticketId)!;
      expect(row.armedAt).not.toBeNull();
      expect(row.enqueuedAt).toBeNull();
      expect(h.sent).toEqual([]);
    });

    it('push route, idle but the fix launch intent is still pending: arms only', () => {
      h.state.idle = true;
      recordSessionLaunchIntent(h.store, {
        ticketId: h.ticketId,
        launchId: 'L1',
        purpose: 'fix',
        provider: 'claude',
        reason: 'fix',
        sessionOrigin: 'new',
        recoveryRoundId: h.openRound(),
        at: '2026-01-01T00:00:00Z',
      } as never);
      expect(deliverLiveFix(h.host, input())).toBe(true);
      const row = currentFixDelivery(h.store, h.ticketId)!;
      expect(row.armedAt).not.toBeNull();
      expect(row.enqueuedAt).toBeNull();
      expect(h.sent).toEqual([]);
    });

    it('push route, idle but an OLDER unread row waits for the pointer: arms only', () => {
      const older = upsertFixDelivery(h.store, { ticketId: h.ticketId, recoveryRoundId: null, launchId: 'L1', body: 'C', at: h.host.now(), kind: 'conflict', repo: 'api' });
      claimArmed(h.store, older, h.host.now());
      h.state.idle = true;
      expect(deliverLiveFix(h.host, input())).toBe(true);
      const row = currentFixDelivery(h.store, h.ticketId)!;
      expect(row.id).not.toBe(older);
      expect(row.armedAt).not.toBeNull();
      expect(row.enqueuedAt).toBeNull();
      expect(h.sent).toEqual([]);
    });

    it.each(['unavailable', 'held'] as const)('push route, idle, the send is %s: the row stays armed, never superseded', (result) => {
      h.state.idle = true;
      h.state.sendResult = result;
      expect(deliverLiveFix(h.host, input())).toBe(true);
      const row = currentFixDelivery(h.store, h.ticketId)!;
      expect(row.armedAt).not.toBeNull();
      expect(row.supersededAt).toBeNull();
      expect(row.enqueuedAt).toBeNull();
      expect(row.pointerFailedAt).toBeNull();
      const lines = vi.mocked(h.host.debug).mock.calls.map((c) => String(c[0]));
      expect(lines.some((l) => l.includes('idle push session') && l.includes(`immediate pointer ${result}`))).toBe(true);
    });

    it('push route, idle, the pointer cannot be built: fails the pointer once', () => {
      h.state.idle = true;
      h.state.sendResult = 'pointer-null';
      expect(deliverLiveFix(h.host, input())).toBe(true);
      const row = currentFixDelivery(h.store, h.ticketId)!;
      expect(row.pointerFailedAt).not.toBeNull();
      expect(row.enqueuedAt).toBeNull();
      expect(h.needsYou).toHaveLength(1);
    });

    it('typed route, idle: claims enqueued and types the pointer; typing claims pointed', () => {
      h.state.route = 'typed';
      expect(deliverLiveFix(h.host, input())).toBe(true);
      const row = currentFixDelivery(h.store, h.ticketId)!;
      expect(row.enqueuedAt).not.toBeNull();
      expect(row.armedAt).toBeNull();
      expect(h.sent).toHaveLength(1);
      expect(row.pointedAt).toBeNull();
      h.sent[0]!.hooks.onTyped!();
      expect(getFixDelivery(h.store, row.id)!.pointedAt).not.toBeNull();
    });

    it('typed route, idle agent_state: unchanged (the typed route does not consult it)', () => {
      h.state.route = 'typed';
      h.state.idle = true;
      expect(deliverLiveFix(h.host, input())).toBe(true);
      const row = currentFixDelivery(h.store, h.ticketId)!;
      expect(row.armedAt).toBeNull();
      expect(row.enqueuedAt).not.toBeNull();
      expect(h.sent).toHaveLength(1);
    });

    it('typed route, idle agent_state but running: still held for the sweep', () => {
      h.state.route = 'typed';
      h.state.idle = true;
      h.state.running = true;
      expect(deliverLiveFix(h.host, input())).toBe(true);
      expect(h.sent).toEqual([]);
      expect(currentFixDelivery(h.store, h.ticketId)!.enqueuedAt).toBeNull();
    });

    it('a conflict row on a push route, idle: typed at arm like a fix row', () => {
      h.state.idle = true;
      expect(deliverLiveFix(h.host, input({ kind: 'conflict', repo: 'api', body: 'C' }))).toBe(true);
      const row = currentConflictDelivery(h.store, h.ticketId, 'api')!;
      expect(row.armedAt).not.toBeNull();
      expect(row.enqueuedAt).not.toBeNull();
      expect(h.sent).toHaveLength(1);
    });

    it('typed route: a dropped line frees the in-flight claim', () => {
      h.state.route = 'typed';
      deliverLiveFix(h.host, input());
      const id = currentFixDelivery(h.store, h.ticketId)!.id;
      h.sent[0]!.hooks.onDropped!();
      expect(getFixDelivery(h.store, id)!.enqueuedAt).toBeNull();
    });

    it('typed route, running: types nothing and leaves the row for the sweep', () => {
      h.state.route = 'typed';
      h.state.running = true;
      expect(deliverLiveFix(h.host, input())).toBe(true);
      expect(h.sent).toEqual([]);
      expect(currentFixDelivery(h.store, h.ticketId)!.enqueuedAt).toBeNull();
    });

    it('typed route, held (agy busy): row stays, claim freed, success', () => {
      h.state.route = 'typed';
      h.state.sendResult = 'held';
      expect(deliverLiveFix(h.host, input())).toBe(true);
      expect(currentFixDelivery(h.store, h.ticketId)!.enqueuedAt).toBeNull();
    });

    it('typed route, no terminal took it: fails and supersedes the row', () => {
      h.state.route = 'typed';
      h.state.sendResult = 'unavailable';
      expect(deliverLiveFix(h.host, input())).toBe(false);
      expect(currentFixDelivery(h.store, h.ticketId)).toBeNull();
    });

    it('typed route, unbuildable pointer: fails the pointer once and asks for a human', () => {
      h.state.route = 'typed';
      h.state.sendResult = 'pointer-null';
      expect(deliverLiveFix(h.host, input())).toBe(true);
      const row = currentFixDelivery(h.store, h.ticketId)!;
      expect(row.pointerFailedAt).not.toBeNull();
      expect(h.needsYou).toHaveLength(1);
    });

    it('a new delivery supersedes the unread previous one', () => {
      deliverLiveFix(h.host, input({ body: 'OLD' }));
      const old = currentFixDelivery(h.store, h.ticketId)!.id;
      deliverLiveFix(h.host, input({ body: 'NEW' }));
      expect(getFixDelivery(h.store, old)!.supersededAt).not.toBeNull();
      expect(currentFixDelivery(h.store, h.ticketId)!.body).toBe('NEW');
    });

    it('a tracked round re-delivered upserts the same row', () => {
      const roundId = h.openRound();
      deliverLiveFix(h.host, input({ roundId }));
      const first = currentFixDelivery(h.store, h.ticketId)!.id;
      deliverLiveFix(h.host, input({ roundId, body: 'AGAIN' }));
      expect(currentFixDelivery(h.store, h.ticketId)).toMatchObject({ id: first, body: 'AGAIN' });
    });
  });

  describe('eligibleFixDelivery', () => {
    const armed = (): number => {
      deliverLiveFix(h.host, input());
      return currentFixDelivery(h.store, h.ticketId)!.id;
    };

    it('returns the armed, unpointed, current-generation row', () => {
      const id = armed();
      expect(eligibleFixDelivery(h.host, h.ticketId)?.id).toBe(id);
    });

    it('null when there is no row', () => {
      expect(eligibleFixDelivery(h.host, h.ticketId)).toBeNull();
    });

    it('null for a typed-route row (never armed)', () => {
      h.state.route = 'typed';
      h.state.running = true;
      deliverLiveFix(h.host, input());
      expect(eligibleFixDelivery(h.host, h.ticketId)).toBeNull();
    });

    it('null once read, pointed, failed, or a typed line is in flight', () => {
      const id = armed();
      h.store.db.prepare('UPDATE fix_deliveries SET enqueued_at = ? WHERE id = ?').run('x', id);
      expect(eligibleFixDelivery(h.host, h.ticketId)).toBeNull();
      h.store.db.prepare('UPDATE fix_deliveries SET enqueued_at = NULL, pointed_at = ? WHERE id = ?').run('x', id);
      expect(eligibleFixDelivery(h.host, h.ticketId)).toBeNull();
      h.store.db.prepare('UPDATE fix_deliveries SET pointed_at = NULL, pointer_failed_at = ? WHERE id = ?').run('x', id);
      expect(eligibleFixDelivery(h.host, h.ticketId)).toBeNull();
      h.store.db.prepare('UPDATE fix_deliveries SET pointer_failed_at = NULL WHERE id = ?').run(id);
      claimRead(h.store, id, 'pointer', 'x');
      expect(eligibleFixDelivery(h.host, h.ticketId)).toBeNull();
    });

    it('null when the live generation differs (NULL-safe)', () => {
      armed();
      h.state.launchId = 'L2';
      expect(eligibleFixDelivery(h.host, h.ticketId)).toBeNull();
      h.state.launchId = undefined;
      expect(eligibleFixDelivery(h.host, h.ticketId)).toBeNull();
    });

    it('a NULL-launch row is eligible while no generation is tracked', () => {
      h.state.launchId = undefined;
      const id = armed();
      expect(eligibleFixDelivery(h.host, h.ticketId)?.id).toBe(id);
    });

    it('null while an unconfirmed fix launch intent is pending for the generation', () => {
      armed();
      const roundId = h.openRound();
      recordSessionLaunchIntent(h.store, {
        ticketId: h.ticketId,
        launchId: 'L1',
        purpose: 'fix',
        provider: 'claude',
        reason: 'fix',
        sessionOrigin: 'new',
        recoveryRoundId: roundId,
        at: '2026-01-01T00:00:00Z',
      } as never);
      expect(eligibleFixDelivery(h.host, h.ticketId)).toBeNull();
    });
  });

  describe('sendTypedPointer', () => {
    it('first send is refused when another tick already claimed it', () => {
      const id = upsertFixDelivery(h.store, { ticketId: h.ticketId, recoveryRoundId: null, launchId: 'L1', body: 'b', at: 'a' });
      const row = getFixDelivery(h.store, id)!;
      expect(sendTypedPointer(h.host, row, 'first')).toBe('queued');
      expect(sendTypedPointer(h.host, row, 'first')).toBe('raced');
      expect(h.sent).toHaveLength(1);
    });

    it('a non-queued result frees the first-send claim', () => {
      const id = upsertFixDelivery(h.store, { ticketId: h.ticketId, recoveryRoundId: null, launchId: 'L1', body: 'b', at: 'a' });
      h.state.sendResult = 'held';
      expect(sendTypedPointer(h.host, getFixDelivery(h.store, id)!, 'first')).toBe('held');
      expect(getFixDelivery(h.store, id)!.enqueuedAt).toBeNull();
    });

    it('a resend does not claim enqueued and claims repointed on typing', () => {
      const id = upsertFixDelivery(h.store, { ticketId: h.ticketId, recoveryRoundId: null, launchId: 'L1', body: 'b', at: 'a' });
      claimArmed(h.store, id, 'a');
      expect(sendTypedPointer(h.host, getFixDelivery(h.store, id)!, 'resend')).toBe('queued');
      expect(getFixDelivery(h.store, id)!.enqueuedAt).toBeNull();
      h.sent[0]!.hooks.onTyped!();
      expect(getFixDelivery(h.store, id)!.repointedAt).not.toBeNull();
      h.sent[0]!.hooks.onDropped!();
      expect(getFixDelivery(h.store, id)!.enqueuedAt).toBeNull();
    });

    it('after the immediate idle send, no hook pointer is eligible', () => {
      h.state.idle = true;
      deliverLiveFix(h.host, input());
      expect(h.sent).toHaveLength(1);
      expect(eligibleFixDelivery(h.host, h.ticketId)).toBeNull();
    });

    it('a hook that pointed first makes the first typed send race: never a second pointer', () => {
      const id = upsertFixDelivery(h.store, { ticketId: h.ticketId, recoveryRoundId: null, launchId: 'L1', body: 'b', at: 'a' });
      claimArmed(h.store, id, 'a');
      claimPointed(h.store, id, 'a');
      expect(sendTypedPointer(h.host, getFixDelivery(h.store, id)!, 'first')).toBe('raced');
      expect(h.sent).toEqual([]);
    });
  });

  it('failPointer claims once and asks for a human once', () => {
    const id = upsertFixDelivery(h.store, { ticketId: h.ticketId, recoveryRoundId: null, launchId: 'L1', body: 'b', at: 'a' });
    const row = getFixDelivery(h.store, id)!;
    failPointer(h.host, row);
    failPointer(h.host, row);
    expect(h.needsYou).toHaveLength(1);
  });
});

describe('ackFixDeliveryRef (sandbox ack line, F10)', () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
  });
  afterEach(() => h.store.close());
  const at = '2026-10-19T10:00:00.000Z';
  const make = () => {
    deliverLiveFix(h.host, { ticketId: h.ticketId, roundId: null, body: 'B', truncatedFooter: 'F' });
    return currentFixDelivery(h.store, h.ticketId)!;
  };

  it('marks this ticket\'s pending delivery read, via the pointer', () => {
    const row = make();
    expect(ackFixDeliveryRef(h.store, h.ticketId, `fix-${row.id}`, at)).toBe(true);
    expect(getFixDelivery(h.store, row.id)).toMatchObject({ readAt: at, deliveredVia: 'pointer' });
  });
  it('a second ack, a malformed ref and another kind change nothing', () => {
    const row = make();
    expect(ackFixDeliveryRef(h.store, h.ticketId, `fix-${row.id}`, at)).toBe(true);
    expect(ackFixDeliveryRef(h.store, h.ticketId, `fix-${row.id}`, at)).toBe(false);
    for (const ref of ['fix-0', 'fix-01x', 'mail-1', 'fix-', `fix-${row.id}-x`, `xfix-${row.id}`, `fix-${row.id}x`, `fix-${row.id}\n`, 'fix-12345678901', 'fix-a1']) expect(ackFixDeliveryRef(h.store, h.ticketId, ref, at)).toBe(false);
  });
  it('a ref naming another ticket\'s delivery is refused', () => {
    const row = make();
    expect(ackFixDeliveryRef(h.store, h.ticketId + 1, `fix-${row.id}`, at)).toBe(false);
    expect(getFixDelivery(h.store, row.id)!.readAt).toBeNull();
  });
  it('a superseded delivery is no longer pending', () => {
    const row = make();
    h.store.db.prepare('UPDATE fix_deliveries SET superseded_at = ? WHERE id = ?').run(at, row.id);
    expect(ackFixDeliveryRef(h.store, h.ticketId, `fix-${row.id}`, at)).toBe(false);
  });
  it('a missing delivery is ignored', () => {
    expect(ackFixDeliveryRef(h.store, h.ticketId, 'fix-999', at)).toBe(false);
  });
});
