import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  claimRead,
  claimPointed,
  currentFixDelivery,
  getFixDelivery,
} from '../../store/fixDeliveries.js';
import { setStageCurrent } from '../../store/tickets.js';
import { deliverLiveFix } from './fixDeliveryOps.js';
import {
  ARMED_FIX_TIMEOUT_MS,
  FIX_ENQUEUE_STALE_MS,
  FIX_POINTER_RESEND_MS,
  FIX_UNREAD_NEEDS_YOU_MS,
  makeFixDeliverySweep,
} from './fixDeliverySweep.js';
import { makeHarness, type Harness } from '../../store/fixtures/fixDeliveryHarness.js';

describe('fixDeliverySweep', () => {
  let h: Harness;
  let sweep: () => void;
  beforeEach(() => {
    h = makeHarness();
    const s = makeFixDeliverySweep({ ...h.host, projectId: () => h.projectId });
    sweep = () => s.sweep();
  });
  afterEach(() => h.store.close());

  const deliver = (roundId: number | null = null): number => {
    deliverLiveFix(h.host, { ticketId: h.ticketId, roundId, body: 'B', truncatedFooter: '' });
    return currentFixDelivery(h.store, h.ticketId)!.id;
  };
  const row = (id: number) => getFixDelivery(h.store, id)!;
  const typeAll = () => h.sent.forEach((s) => s.hooks.onTyped?.());

  describe('gates', () => {
    it.each([
      ['not live in this window', () => (h.state.live = false)],
      ['graph ticket', () => (h.state.graph = true)],
      ['ticket left the fix stage', () => setStageCurrent(h.store, h.ticketId, 'uat')],
    ])('does nothing: %s', (_name, arrange) => {
      h.state.route = 'typed';
      h.state.running = true;
      const id = deliver();
      h.state.running = false;
      arrange();
      h.advance(10 * 60_000);
      sweep();
      expect(h.sent).toEqual([]);
      expect(row(id).enqueuedAt).toBeNull();
    });

    it('does nothing for a tracked row whose round is no longer active', () => {
      h.state.route = 'typed';
      h.state.running = true;
      const roundId = h.openRound();
      deliver(roundId);
      h.store.db.prepare("UPDATE recovery_rounds SET status = 'interrupted' WHERE id = ?").run(roundId);
      h.state.running = false;
      sweep();
      expect(h.sent).toEqual([]);
    });

    it('keeps a tracked row whose round is active', () => {
      h.state.route = 'typed';
      h.state.running = true;
      const roundId = h.openRound();
      deliver(roundId);
      h.state.running = false;
      sweep();
      expect(h.sent).toHaveLength(1);
    });

    it('does nothing when the project is unbound', () => {
      h.state.route = 'typed';
      h.state.running = true;
      deliver();
      h.state.running = false;
      makeFixDeliverySweep({ ...h.host, projectId: () => undefined }).sweep();
      expect(h.sent).toEqual([]);
    });

    it('skips a row whose seed launch is unconfirmed', () => {
      h.state.route = 'typed';
      h.state.running = true;
      const id = deliver();
      h.state.running = false;
      const roundId = h.openRound();
      h.store.db
        .prepare(
          `INSERT INTO session_launch_intents (ticket_id, launch_id, purpose, provider, reason, session_origin, recovery_round_id, status, created_at)
           VALUES (?, 'L1', 'fix', 'claude', 'fix', 'new', ?, 'pending', ?)`,
        )
        .run(h.ticketId, roundId, '2026-01-01T00:00:00Z');
      sweep();
      expect(h.sent).toEqual([]);
      expect(row(id).enqueuedAt).toBeNull();
    });
  });

  describe('rule 0: typed route first send', () => {
    beforeEach(() => {
      h.state.route = 'typed';
    });

    it('is held while the agent is running, then sent on the first idle tick', () => {
      h.state.running = true;
      const id = deliver();
      sweep();
      expect(h.sent).toEqual([]);
      h.state.running = false;
      sweep();
      expect(h.sent).toHaveLength(1);
      expect(row(id).enqueuedAt).not.toBeNull();
    });

    it('sends once: a second tick while the line is in flight does nothing', () => {
      h.state.running = true;
      deliver();
      h.state.running = false;
      sweep();
      sweep();
      expect(h.sent).toHaveLength(1);
    });

    it('re-sends after a dropped line', () => {
      h.state.running = true;
      deliver();
      h.state.running = false;
      sweep();
      h.sent[0]!.hooks.onDropped!();
      sweep();
      expect(h.sent).toHaveLength(2);
    });

    it('frees a claim whose line was lost (reload), then re-sends', () => {
      h.state.running = true;
      const id = deliver();
      h.state.running = false;
      sweep();
      h.advance(FIX_ENQUEUE_STALE_MS);
      sweep();
      expect(row(id).enqueuedAt).toBeNull();
      sweep();
      expect(h.sent).toHaveLength(2);
    });

    it('fails an unbuildable pointer once and never retries', () => {
      h.state.running = true;
      const id = deliver();
      h.state.running = false;
      h.state.sendResult = 'pointer-null';
      sweep();
      sweep();
      expect(row(id).pointerFailedAt).not.toBeNull();
      expect(h.needsYou).toHaveLength(1);
      expect(h.sent).toHaveLength(1);
    });
  });

  describe('rule 1: re-arm on generation change', () => {
    it('push route: new generation, fresh armed clock, nothing sent', () => {
      const id = deliver();
      h.advance(ARMED_FIX_TIMEOUT_MS * 3);
      h.state.launchId = 'L2';
      sweep();
      expect(h.sent).toEqual([]);
      expect(row(id)).toMatchObject({ launchId: 'L2' });
      expect(row(id).armedAt).toBe(new Date(h.clock.ms).toISOString());
    });

    it('typed route: re-armed unarmed, then the first send happens on the next tick', () => {
      h.state.route = 'typed';
      h.state.running = true;
      const id = deliver();
      h.state.launchId = 'L2';
      sweep();
      expect(row(id)).toMatchObject({ launchId: 'L2', armedAt: null });
      h.state.running = false;
      sweep();
      expect(h.sent).toHaveLength(1);
    });

    it('re-arms a NULL-launch row once a generation appears', () => {
      h.state.launchId = undefined;
      const id = deliver();
      h.state.launchId = 'L9';
      sweep();
      expect(row(id).launchId).toBe('L9');
    });

    it('does not re-arm without a tracked generation', () => {
      const id = deliver();
      h.state.launchId = undefined;
      sweep();
      expect(row(id).launchId).toBe('L1');
    });

    it('a re-arm of a pointed row resets the whole ladder', () => {
      const id = deliver();
      claimPointed(h.store, id, new Date(h.clock.ms).toISOString());
      h.state.launchId = 'L2';
      sweep();
      expect(row(id).pointedAt).toBeNull();
    });
  });

  describe('an un-armed row on a push route', () => {
    it('is armed by the sweep, then falls through the normal ladder', () => {
      h.state.route = 'typed';
      h.state.running = true;
      const id = deliver();
      h.state.route = 'hook-block';
      sweep();
      expect(row(id).armedAt).toBe(new Date(h.clock.ms).toISOString());
      expect(h.sent).toEqual([]);
      h.state.running = false;
      h.advance(ARMED_FIX_TIMEOUT_MS);
      sweep();
      expect(h.sent).toHaveLength(1);
    });
  });

  describe('rule 3: armed fallback (idle push-route agent)', () => {
    it('types one pointer after 60 s, never before', () => {
      const id = deliver();
      h.advance(ARMED_FIX_TIMEOUT_MS - 1);
      sweep();
      expect(h.sent).toEqual([]);
      h.advance(1);
      sweep();
      expect(h.sent).toHaveLength(1);
      expect(row(id).enqueuedAt).not.toBeNull();
      sweep();
      expect(h.sent).toHaveLength(1);
    });

    it('holds while the agent is mid-turn (the hook will point at the turn end)', () => {
      deliver();
      h.advance(ARMED_FIX_TIMEOUT_MS * 5);
      h.state.running = true;
      sweep();
      expect(h.sent).toEqual([]);
    });

    it('does nothing once the hook already pointed', () => {
      const id = deliver();
      claimPointed(h.store, id, new Date(h.clock.ms).toISOString());
      h.advance(ARMED_FIX_TIMEOUT_MS * 2);
      sweep();
      expect(h.sent).toEqual([]);
    });
  });

  describe('rules 4 and 5: unread escalation', () => {
    const pointed = (): number => {
      const id = deliver();
      claimPointed(h.store, id, new Date(h.clock.ms).toISOString());
      return id;
    };

    it('re-sends once, typed, after 5 min; typing claims repointed', () => {
      const id = pointed();
      h.advance(FIX_POINTER_RESEND_MS - 1);
      sweep();
      expect(h.sent).toEqual([]);
      h.advance(1);
      sweep();
      expect(h.sent).toHaveLength(1);
      expect(row(id).enqueuedAt).toBeNull();
      typeAll();
      expect(row(id).repointedAt).not.toBeNull();
      h.advance(FIX_POINTER_RESEND_MS);
      sweep();
      expect(h.sent).toHaveLength(1);
    });

    it('holds the re-send while running', () => {
      pointed();
      h.advance(FIX_POINTER_RESEND_MS);
      h.state.running = true;
      sweep();
      expect(h.sent).toEqual([]);
    });

    it('does not hammer: an un-typed resend is not repeated inside a minute', () => {
      pointed();
      h.advance(FIX_POINTER_RESEND_MS);
      sweep();
      sweep();
      expect(h.sent).toHaveLength(1);
      h.advance(60_000);
      sweep();
      expect(h.sent).toHaveLength(2);
    });

    it('needs-you 15 min after the re-send went unread', () => {
      const id = pointed();
      h.advance(FIX_POINTER_RESEND_MS);
      sweep();
      typeAll();
      h.advance(FIX_UNREAD_NEEDS_YOU_MS - 1);
      sweep();
      expect(h.needsYou).toEqual([]);
      h.advance(1);
      sweep();
      expect(h.needsYou).toHaveLength(1);
      expect(row(id).readAt).toBeNull();
    });

    it('fails an unbuildable resend pointer', () => {
      const id = pointed();
      h.advance(FIX_POINTER_RESEND_MS);
      h.state.sendResult = 'pointer-null';
      sweep();
      expect(row(id).pointerFailedAt).not.toBeNull();
    });

    it('a read row is never touched', () => {
      const id = pointed();
      claimRead(h.store, id, 'pointer', new Date(h.clock.ms).toISOString());
      h.advance(FIX_UNREAD_NEEDS_YOU_MS * 2);
      sweep();
      expect(h.sent).toEqual([]);
      expect(h.needsYou).toEqual([]);
    });
  });

  it('a throwing seam is contained and logged, never thrown', () => {
    h.state.route = 'typed';
    h.state.running = true;
    deliver();
    h.state.running = false;
    const s = makeFixDeliverySweep({
      ...h.host,
      projectId: () => h.projectId,
      sendPointer: () => {
        throw new Error('boom');
      },
    });
    expect(() => s.sweep()).not.toThrow();
    expect(h.host.debug).toHaveBeenCalledWith(expect.stringContaining('sweep failed (boom)'));
  });
});
