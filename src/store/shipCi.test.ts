import { beforeEach, describe, expect, it } from 'vitest';
import { openStore, type Store } from './db.js';
import { createTicket, getTicket, listTickets, pauseTicket, setStageCurrent } from './tickets.js';
import { setStage } from './stages.js';
import { recordShippedPr } from './prs.js';
import { setMergeCheck } from './mergeChecks.js';
import { setAutopilotPaused, setAutopilotStopped } from './autopilot.js';
import { setShipCiDebug, shipCiReading, type ShipCiPr } from './shipCi.js';
import type { PrChecks } from '../model/prChecks.js';
import { finishDeliverRun, openDeliverRun } from './deliverRuns.js';
import { ticketGlyph } from '../model/ticketGlyph.js';
import { stageBadge } from '../model/stageBadge.js';

const pending = JSON.stringify({ state: 'pending', total: 2, passed: 1, failed: 0, pending: 1, failing: [], failedShown: 0 });
const failing = JSON.stringify({ state: 'failing', total: 2, passed: 1, failed: 1, pending: 0, failing: [], failedShown: 1 });
const passing = JSON.stringify({ state: 'passing', total: 2, passed: 2, failed: 0, pending: 0, failing: [], failedShown: 0 });

describe('derived shipCi on loaded tickets', () => {
  let store: Store;
  let id: number;
  beforeEach(() => {
    store = openStore(':memory:');
    id = createTicket(store, { key: 'K-1', title: 't' }).id;
    setStageCurrent(store, id, 'ship');
    setStage(store, id, 'ship', { status: 'passed', blockedKind: 'awaiting-merge', blockedReason: 'x' });
  });

  function pr(repo: string, number: number, checks: string | null, mergeBlock: string | null): void {
    const url = `https://gh/${repo}/pull/${number}`;
    recordShippedPr(store, { ticketId: id, repo, number, url });
    store.db.prepare('UPDATE prs SET checks = ?, merge_block = ? WHERE url = ?').run(checks, mergeBlock, url);
  }
  const reading = (): unknown => getTicket(store, id).shipCi ?? null;

  it('pending + blocked reads running in getTicket and listTickets, blue and CI running', () => {
    pr('a', 1, pending, 'blocked');
    expect(reading()).toBe('running');
    const t = listTickets(store).find((x) => x.id === id)!;
    expect(t.shipCi).toBe('running');
    expect(ticketGlyph(t)).toBe('blue');
    expect(stageBadge(t).label).toBe('CI running');
  });

  it('pending + clean stays amber', () => {
    pr('a', 1, pending, 'clean');
    expect(reading()).toBeNull();
    expect(ticketGlyph(getTicket(store, id))).toBe('amber');
  });

  it('failing, passing, unknown and unprobed PRs read null', () => {
    pr('a', 1, failing, 'blocked');
    expect(reading()).toBeNull();
    store.db.prepare('UPDATE prs SET checks = ? ').run(passing);
    expect(reading()).toBeNull();
    store.db.prepare('UPDATE prs SET checks = NULL, merge_block = NULL').run();
    expect(reading()).toBeNull();
  });

  it('a conflicted merge check reads null', () => {
    pr('a', 1, pending, 'blocked');
    setMergeCheck(store, { ticketId: id, repo: 'a', state: 'conflicted', files: ['f'], reason: null, headSha: null, baseSha: null, baseRef: null, checkedAt: '2026-01-01T00:00:00Z' });
    expect(reading()).toBeNull();
  });

  it('two PRs: pending + green reads running, pending + failing reads null', () => {
    pr('a', 1, pending, 'blocked');
    pr('b', 2, passing, 'clean');
    expect(reading()).toBe('running');
    store.db.prepare(`UPDATE prs SET checks = ? WHERE repo = 'b'`).run(failing);
    expect(reading()).toBeNull();
  });

  it('a dismissed or merged PR is ignored', () => {
    pr('a', 1, pending, 'blocked');
    store.db.prepare(`UPDATE prs SET status = 'merged'`).run();
    expect(reading()).toBeNull();
  });

  it('an autopilot park stays amber', () => {
    pr('a', 1, pending, 'blocked');
    setAutopilotStopped(store, id, 'budget spent');
    expect(reading()).toBeNull();
    setAutopilotStopped(store, id, null);
    setAutopilotPaused(store, id, 'waiting');
    expect(reading()).toBeNull();
  });

  it('a paused ticket and a ticket not at ship carry no reading', () => {
    pr('a', 1, pending, 'blocked');
    pauseTicket(store, id);
    expect(getTicket(store, id).shipCi).toBeUndefined();
  });
});

describe('shipCiReading', () => {
  it('a dirty PR or no PR reads null', () => {
    expect(shipCiReading([{ checks: 'pending', mergeBlock: 'dirty' }], false)).toBeNull();
    expect(shipCiReading([], false)).toBeNull();
    expect(shipCiReading([{ checks: 'pending', mergeBlock: 'blocked' }], false)).toBe('running');
  });
  it.each(['clean', 'unstable', 'has_hooks', 'behind', 'draft', 'unknown'] as const)(
    'pending with merge_block %s stays amber',
    (mergeBlock) => {
      expect(shipCiReading([{ checks: 'pending', mergeBlock }], false)).toBeNull();
    },
  );
});

describe('shipCiReading with an optional-only failure', () => {
  const checks = (over: Partial<PrChecks> = {}): PrChecks => ({
    state: 'failing', total: 5, passed: 1, failed: 1, pending: 3,
    failing: [{ name: 'Mutation score', url: null, required: false }], failedShown: 1,
    required: { total: 4, failed: 0, pending: 2 },
    ...over,
  });
  const read = (c: PrChecks, mergeBlock: ShipCiPr['mergeBlock'] = 'blocked'): unknown =>
    shipCiReading([{ checks: c.state, mergeBlock, rollup: c }], false);

  it('the T1115 rollup reads running', () => {
    expect(read(checks())).toBe('running');
  });
  it('a failure with required null or absent reads null', () => {
    expect(read(checks({ failing: [{ name: 'Mutation score', url: null, required: null }] }))).toBeNull();
    expect(read(checks({ failing: [{ name: 'Mutation score', url: null }] }))).toBeNull();
  });
  it('a required failure reads null', () => {
    expect(read(checks({ required: { total: 4, failed: 1, pending: 2 } }))).toBeNull();
  });
  it('no required split reads null', () => {
    expect(read(checks({ required: null }))).toBeNull();
  });
  it('no pending required check reads null', () => {
    expect(read(checks({ required: { total: 4, failed: 0, pending: 0 } }))).toBeNull();
  });
  it('a cut-short failing list reads null', () => {
    expect(read(checks({ failed: 12, failedShown: 10 }))).toBeNull();
  });
  it('merge_block clean or dirty reads null', () => {
    expect(read(checks(), 'clean')).toBeNull();
    expect(read(checks(), 'dirty')).toBeNull();
  });
  it('a second PR that fails a required check reads null', () => {
    const bad = checks({ required: { total: 4, failed: 1, pending: 2 } });
    expect(shipCiReading([{ checks: 'failing', mergeBlock: 'blocked', rollup: checks() }, { checks: 'failing', mergeBlock: 'blocked', rollup: bad }], false)).toBeNull();
  });
});

describe('deliverRunning on loaded tickets', () => {
  it('is true while the current deliver run runs, false after it ends, absent when ship is not awaiting merge', () => {
    const store = openStore(':memory:');
    const id = createTicket(store, { key: 'K-5', title: 't' }).id;
    setStageCurrent(store, id, 'ship');
    setStage(store, id, 'ship', { status: 'passed', blockedKind: 'awaiting-merge', blockedReason: 'x' });
    expect(getTicket(store, id).deliverRunning).toBe(false);
    const run = openDeliverRun(store, { ticketId: id, headSha: 'abc', gates: ['integration'], pid: 1, now: '2026-01-01T00:00:00Z', kind: 'auto' });
    expect(getTicket(store, id).deliverRunning).toBe(true);
    expect(listTickets(store).find((x) => x.id === id)!.deliverRunning).toBe(true);
    finishDeliverRun(store, run, 'passed', '2026-01-01T00:01:00Z');
    expect(getTicket(store, id).deliverRunning).toBe(false);
    pauseTicket(store, id);
    expect(getTicket(store, id).deliverRunning).toBeUndefined();
  });
});

describe('a failing read', () => {
  it('a dropped merge_checks table reads null and does not throw', () => {
    const store = openStore(':memory:');
    const id = createTicket(store, { key: 'K-9', title: 't' }).id;
    setStageCurrent(store, id, 'ship');
    setStage(store, id, 'ship', { status: 'passed', blockedKind: 'awaiting-merge', blockedReason: 'x' });
    store.db.exec('DROP TABLE merge_checks');
    const seen: string[] = [];
    setShipCiDebug((m) => seen.push(m));
    try {
      expect(getTicket(store, id).shipCi).toBeNull();
    } finally {
      setShipCiDebug(undefined);
    }
    expect(seen[0]).toContain('[merge] shipCi read failed');
  });
});
