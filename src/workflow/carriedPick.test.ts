import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { openStore, type Store } from '../store/db.js';
import { createTicket } from '../store/tickets.js';
import { claimUsageLimitPark, insertOpenPark } from '../store/usageLimitParks.js';
import type { AgentAdapter } from '../agent/adapter.js';
import type { QuotaSnapshot } from '../agent/quota/types.js';
import {
  DEFAULT_CARRY_WINDOW_MS,
  carryChoices,
  carryUntilFor,
  formatCarryTime,
  quotaResetAt,
  resolveLaneProcess,
} from './carriedPick.js';

const adapter: AgentAdapter = {
  requiredBinary: 'fake',
  capabilities: { lifecycleEvents: false, resume: false },
  buildInteractiveCommand: () => ({ command: 'fake', args: [], env: {} }),
  runHeadless: async () => ({ sessionId: '', verdict: null, raw: '[]' }),
};

describe('resolveLaneProcess — the carried-pick lane guard (T1313, @arch:AC-65)', () => {
  let store: Store;
  let ticketId: number;
  const now = new Date('2026-11-22T12:00:00.000Z');
  beforeEach(() => {
    store = openStore(':memory:');
    ticketId = createTicket(store, { key: 'T-LANE', title: 'thing' }).id;
  });
  afterEach(() => store.close());

  const pick = (carry: boolean, until = '2026-11-22T15:00:00.000Z'): void => {
    const id = insertOpenPark(store, {
      ticketId, stage: 'uat', kind: 'stage-block', lane: 'uat', target: 'repo',
      provider: 'antigravity', model: 'gemini-4-hydrogen-medium', detail: 'Antigravity usage limit reached.',
      keptOutcome: null, parkedAt: '2026-11-22T10:00:00.000Z',
    });
    // A stage-block claim needs the stage blocked on usage-limit.
    store.db
      .prepare("UPDATE stages SET blocked_kind = 'usage-limit' WHERE ticket_id = ? AND stage_key = 'uat'")
      .run(ticketId);
    const claim = claimUsageLimitPark(
      store, id, 'pick', '2026-11-22T10:05:00.000Z',
      carry ? { provider: 'claude', model: 'claude-opus-5-5', until } : undefined,
    );
    expect(claim.claimed).toBe(true);
  };
  const resolver = () =>
    vi.fn((override?: { provider: string; model: string | null }) => ({
      assignment: { agentName: 'Review Agent', provider: (override?.provider ?? 'antigravity') as 'antigravity' },
      adapter,
    }));
  const run = (resolve: ReturnType<typeof resolver>, provider = 'antigravity', at = now) => {
    const activity = vi.fn();
    const bundle = resolveLaneProcess({
      store, ticketId, role: 'review', now: at,
      laneProvider: () => provider,
      resolve, activity,
    });
    return { bundle, activity };
  };

  it('(a) a pick with carry: the lane runs on the picked core, resolved once', () => {
    pick(true);
    const resolve = resolver();
    const { bundle, activity } = run(resolve);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledWith({ provider: 'claude', model: 'claude-opus-5-5' });
    expect(bundle?.assignment.provider).toBe('claude');
    expect(activity).toHaveBeenCalledWith(ticketId, expect.stringMatching(/^used claude\/claude-opus-5-5 from the usage-limit pick until /));
  });

  it('(b) a pick without carry gives the current behaviour', () => {
    pick(false);
    const resolve = resolver();
    const { bundle, activity } = run(resolve);
    expect(resolve).toHaveBeenCalledWith();
    expect(bundle?.assignment.provider).toBe('antigravity');
    expect(activity).not.toHaveBeenCalled();
  });

  it('(c) a carry after carry_until runs the role adapter', () => {
    pick(true, '2026-11-22T11:00:00.000Z');
    const resolve = resolver();
    expect(run(resolve).bundle?.assignment.provider).toBe('antigravity');
    expect(resolve).toHaveBeenCalledWith();
  });

  it('(d) a lane on a different provider ignores the carry', () => {
    pick(true);
    const resolve = resolver();
    expect(run(resolve, 'codex').bundle?.assignment.provider).toBe('antigravity');
    expect(resolve).toHaveBeenCalledWith();
  });

  it('a disabled role stays disabled: a carry never enables it', () => {
    pick(true);
    const activity = vi.fn();
    const bundle = resolveLaneProcess({
      store, ticketId, role: 'uat-tester', now, laneProvider: () => 'antigravity', resolve: () => null, activity,
    });
    expect(bundle).toBeNull();
    expect(activity).not.toHaveBeenCalled();
  });

  it('no provider seam: the carry is never consulted', () => {
    pick(true);
    const resolve = resolver();
    resolveLaneProcess({ store, ticketId, role: 'review', now, resolve });
    expect(resolve).toHaveBeenCalledWith();
  });
});

describe('carry window', () => {
  const now = new Date('2026-11-22T12:00:00.000Z');

  it('uses the park reset when it is ahead', () => {
    expect(carryUntilFor({ resetAt: '2026-11-22T14:00:00.000Z', quotaResetAt: '2026-11-22T13:00:00.000Z', now }))
      .toBe('2026-11-22T14:00:00.000Z');
  });

  it('falls back to the quota window reset, then to now + DEFAULT_CARRY_WINDOW_MS', () => {
    expect(carryUntilFor({ resetAt: '2026-11-22T11:00:00.000Z', quotaResetAt: '2026-11-22T13:00:00.000Z', now }))
      .toBe('2026-11-22T13:00:00.000Z');
    expect(carryUntilFor({ resetAt: null, quotaResetAt: null, now }))
      .toBe(new Date(now.getTime() + DEFAULT_CARRY_WINDOW_MS).toISOString());
    expect(carryUntilFor({ resetAt: now.toISOString(), now }))
      .toBe(new Date(now.getTime() + DEFAULT_CARRY_WINDOW_MS).toISOString());
    expect(DEFAULT_CARRY_WINDOW_MS).toBe(5 * 3_600_000);
  });

  it('reads the tightest open quota window reset; unknown or past reads null', () => {
    const snap: QuotaSnapshot = {
      core: 'claude', state: 'ok', source: 'test', readAt: now.toISOString(),
      windows: [
        { label: '5-hour', usedPct: 100, resetsAt: '2026-11-22T13:30:00.000Z' },
        { label: '7-day', usedPct: 40, resetsAt: '2026-11-25T00:00:00.000Z' },
      ],
    };
    expect(quotaResetAt(snap, now)).toBe('2026-11-22T13:30:00.000Z');
    expect(quotaResetAt({ core: 'claude', state: 'unknown', reason: 'x' }, now)).toBeNull();
    expect(quotaResetAt(undefined, now)).toBeNull();
  });

  it('offers "Only this run" first, then the carry with the time it will use', () => {
    const until = new Date(2026, 10, 22, 15, 5).toISOString();
    const local = new Date(2026, 10, 22, 12, 0);
    const choices = carryChoices(until, local);
    expect(choices.map((c) => c.carry)).toEqual([false, true]);
    expect(choices[0]!.label).toBe('Only this run');
    expect(choices[1]!.label).toBe('Use for this ticket until the limit resets (15:05)');
    expect(formatCarryTime(new Date(2026, 10, 23, 3, 30).toISOString(), local)).toBe('2026-11-23 03:30');
  });
});
