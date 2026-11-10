import { beforeEach, describe, expect, it } from 'vitest';
import { openStore, type Store } from './db.js';
import { createTicket, getTicket, listTickets, pauseTicket, setStageCurrent } from './tickets.js';
import { setStage } from './stages.js';
import { recordShippedPr } from './prs.js';
import { setMergeCheck } from './mergeChecks.js';
import { setAutopilotPaused, setAutopilotStopped } from './autopilot.js';
import { shipCiReading } from './shipCi.js';
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
    expect(shipCiReading([{ checks: 'pending', mergeBlock: 'unknown' }], false)).toBe('running');
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
    expect(getTicket(store, id, (m) => seen.push(m)).shipCi).toBeNull();
    expect(seen[0]).toContain('[merge] shipCi read failed');
  });
});
