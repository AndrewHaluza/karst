import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getFixDelivery, currentFixDelivery, claimArmed, claimRead, upsertFixDelivery } from '../../store/fixDeliveries.js';
import { recordSessionLaunchIntent } from '../../store/sessionLaunchIntents.js';
import { deliverLiveFix, eligibleFixDelivery, failPointer, sendTypedPointer } from './fixDeliveryOps.js';
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

  describe('deliverLiveFix', () => {
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
  });

  it('failPointer claims once and asks for a human once', () => {
    const id = upsertFixDelivery(h.store, { ticketId: h.ticketId, recoveryRoundId: null, launchId: 'L1', body: 'b', at: 'a' });
    const row = getFixDelivery(h.store, id)!;
    failPointer(h.host, row);
    failPointer(h.host, row);
    expect(h.needsYou).toHaveLength(1);
  });
});
