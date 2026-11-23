import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openStore, type Store } from './db.js';
import { createTicket } from './tickets.js';
import {
  claimUsageLimitPark,
  insertOpenPark,
  listActiveCarries,
  listParks,
  recordUsageLimitOpPark,
  reopenUsageLimitPark,
  resolveCarriedPick,
  stopCarriedPick,
} from './usageLimitParks.js';
import { UsageLimitError } from '../agent/cliFailure.js';

// T1313 / @arch:AC-65: the opt-in carried pick on a claimed usage-limit park.
describe('usage-limit carried pick', () => {
  let store: Store;
  let ticketId: number;
  const parkedAt = '2026-11-22T10:00:00.000Z';
  const claimAt = '2026-11-22T10:05:00.000Z';
  const until = '2026-11-22T15:05:00.000Z';
  const beforeUntil = new Date('2026-11-22T12:00:00.000Z');

  beforeEach(() => {
    store = openStore(':memory:');
    ticketId = createTicket(store, { key: 'T-CARRY', title: 'thing' }).id;
  });
  afterEach(() => store.close());

  const park = (provider = 'antigravity', lane = 'analysis', detail = 'Antigravity usage limit reached.'): number =>
    insertOpenPark(store, {
      ticketId,
      stage: 'review',
      kind: 'op',
      lane,
      target: null,
      provider,
      model: 'gemini-4-hydrogen-medium',
      detail,
      keptOutcome: null,
      parkedAt,
    });
  const carry = { provider: 'claude', model: 'claude-opus-5-5', until };

  it('writes the carry in the claim and the lane guard finds it for the parked provider', () => {
    const id = park();
    expect(claimUsageLimitPark(store, id, 'pick', claimAt, carry).claimed).toBe(true);
    const row = resolveCarriedPick(store, ticketId, 'antigravity', beforeUntil);
    expect(row).toMatchObject({ id, carryProvider: 'claude', carryModel: 'claude-opus-5-5', carryUntil: until });
  });

  it('a pick without carry writes no carry (one-shot, the default)', () => {
    const id = park();
    claimUsageLimitPark(store, id, 'pick', claimAt);
    expect(listParks(store, ticketId)[0]).toMatchObject({ carryProvider: null, carryModel: null, carryUntil: null });
    expect(resolveCarriedPick(store, ticketId, 'antigravity', beforeUntil)).toBeNull();
  });

  it('a carry ends at carry_until with no write (the boundary instant is already expired)', () => {
    const id = park();
    claimUsageLimitPark(store, id, 'pick', claimAt, carry);
    expect(resolveCarriedPick(store, ticketId, 'antigravity', new Date(until))).toBeNull();
    expect(resolveCarriedPick(store, ticketId, 'antigravity', new Date('2026-11-22T16:00:00.000Z'))).toBeNull();
    expect(listParks(store, ticketId)[0]!.carryUntil).toBe(until);
  });

  it('a lane on a different provider ignores the carry', () => {
    const id = park();
    claimUsageLimitPark(store, id, 'pick', claimAt, carry);
    expect(resolveCarriedPick(store, ticketId, 'claude', beforeUntil)).toBeNull();
  });

  it('only a pick carries: a retry or a dismiss claim with a carry argument is never read as one', () => {
    const id = park();
    claimUsageLimitPark(store, id, 'retry', claimAt, carry);
    expect(resolveCarriedPick(store, ticketId, 'antigravity', beforeUntil)).toBeNull();
  });

  it('the newest claimed carry wins when two parks of the same provider carry', () => {
    const first = park('antigravity', 'analysis');
    claimUsageLimitPark(store, first, 'pick', claimAt, carry);
    const second = park('antigravity', 'suggest');
    claimUsageLimitPark(store, second, 'pick', '2026-11-22T10:10:00.000Z', { ...carry, model: 'claude-sonnet-5-5' });
    expect(resolveCarriedPick(store, ticketId, 'antigravity', beforeUntil)?.id).toBe(second);
  });

  it('two windows: only the claim winner writes the carry', () => {
    const id = park();
    const winner = claimUsageLimitPark(store, id, 'pick', claimAt, carry);
    const loser = claimUsageLimitPark(store, id, 'pick', claimAt, {
      provider: 'codex',
      model: 'gpt-6',
      until: '2026-11-23T10:00:00.000Z',
    });
    expect(winner.claimed).toBe(true);
    expect(loser).toEqual({ claimed: false, park: null });
    expect(listParks(store, ticketId)[0]).toMatchObject({ carryProvider: 'claude', carryUntil: until });
  });

  it('"Stop using pick" ends the carry now, only for this ticket and only once', () => {
    const id = park();
    claimUsageLimitPark(store, id, 'pick', claimAt, carry);
    const other = createTicket(store, { key: 'T-OTHER', title: 'other' }).id;
    expect(stopCarriedPick(store, other, id, beforeUntil)).toBe(false);
    expect(stopCarriedPick(store, ticketId, id, beforeUntil)).toBe(true);
    expect(listParks(store, ticketId)[0]!.carryUntil).toBe(beforeUntil.toISOString());
    expect(resolveCarriedPick(store, ticketId, 'antigravity', beforeUntil)).toBeNull();
    expect(stopCarriedPick(store, ticketId, id, beforeUntil)).toBe(false);
  });

  it('reopening a claim clears its carry, so a stopped re-run leaves no live carry', () => {
    const id = park();
    claimUsageLimitPark(store, id, 'pick', claimAt, carry);
    expect(reopenUsageLimitPark(store, id, { at: claimAt })).toBe(true);
    expect(listParks(store, ticketId)[0]).toMatchObject({ carryProvider: null, carryModel: null, carryUntil: null });
  });

  it('a done, closed or archived ticket ignores its carries', () => {
    const id = park();
    claimUsageLimitPark(store, id, 'pick', claimAt, carry);
    for (const sql of [
      "UPDATE tickets SET stage_current = 'done' WHERE id = ?",
      "UPDATE tickets SET stage_current = 'closed' WHERE id = ?",
      "UPDATE tickets SET stage_current = 'review', archived_at = '2026-11-22T11:00:00.000Z' WHERE id = ?",
    ]) {
      store.db.prepare(sql).run(ticketId);
      expect(listActiveCarries(store, ticketId, beforeUntil)).toEqual([]);
      expect(resolveCarriedPick(store, ticketId, 'antigravity', beforeUntil)).toBeNull();
    }
    store.db.prepare("UPDATE tickets SET stage_current = 'review', archived_at = NULL WHERE id = ?").run(ticketId);
    expect(resolveCarriedPick(store, ticketId, 'antigravity', beforeUntil)?.id).toBe(id);
  });

  it('parses reset_at from the park detail at insert, and keeps NULL when none is named', () => {
    park('antigravity', 'analysis', 'Antigravity usage limit reached — Resets in 2h0m0s.');
    park('claude', 'suggest', 'Claude usage limit reached.');
    const rows = listParks(store, ticketId);
    expect(rows.find((r) => r.provider === 'antigravity')!.resetAt).toBe('2026-11-22T12:00:00.000Z');
    expect(rows.find((r) => r.provider === 'claude')!.resetAt).toBeNull();
  });

  it('an op park reads the reset from the raw provider detail first', () => {
    const error = new UsageLimitError('Antigravity usage limit reached.', {
      tool: 'Antigravity',
      provider: 'antigravity',
      detail: 'quota exhausted, resets in 30m',
    });
    recordUsageLimitOpPark(store, error, { ticketId, stage: 'review', lane: 'analysis', parkedAt });
    expect(listParks(store, ticketId)[0]!.resetAt).toBe('2026-11-22T10:30:00.000Z');
  });
});
