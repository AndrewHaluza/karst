import { describe, expect, it } from 'vitest';
import { fixtureQueueRow } from '../renderFixtures.js';
import type { QueueRowView } from '../state.js';
import { chainIds, filterQueue, hasChain, hasQueueFilters, liveFilters, matchesQuery, NO_QUEUE_FILTERS, queueSessions, restoreQueueFilters, toggledValue } from './queueFilter.js';

const row = (n: number, o: Partial<QueueRowView> = {}): QueueRowView => fixtureQueueRow(n, { id: n, idLabel: `D${n}`, ...o });
// D1 <- D2 <- D3 (D3 waits on D2, D2 waits on D1); D4 alone; T9 ticket in session-less state.
const rows: QueueRowView[] = [
  row(1, { unblocks: ['D2'], title: 'Retry helper' }),
  row(2, { waitsOn: ['D1'], unblocks: ['D3'], level: 'urgent' }),
  row(3, { waitsOn: ['D2'], sessionLabel: 'P18', sessionTitle: 'auth' }),
  row(4, { sessionLabel: 'P18', sessionTitle: 'auth', level: 'low' }),
  row(9, { kind: 'ticket', idLabel: 'T9', sessionLabel: null, sessionTitle: null, waitsOn: ['T12'] }),
];

describe('restoreQueueFilters', () => {
  it('defaults and drops junk', () => {
    expect(restoreQueueFilters(undefined)).toEqual(NO_QUEUE_FILTERS);
    expect(restoreQueueFilters({ kinds: ['draft', 'x', 3], sessions: ['P1', 'bad'], levels: ['urgent', 'huge'], blocked: ['free', 'no'], chain: 'D5' })).toEqual({
      kinds: ['draft'], sessions: ['P1'], levels: ['urgent'], blocked: ['free'], chain: 'D5',
    });
    expect(restoreQueueFilters({ chain: 'x', kinds: 'draft' })).toEqual(NO_QUEUE_FILTERS);
  });
});

describe('chain', () => {
  it('walks waits and unblocks transitively, not siblings', () => {
    expect([...chainIds(rows, 'D2')].sort()).toEqual(['D1', 'D2', 'D3']);
    expect([...chainIds(rows, 'D1')].sort()).toEqual(['D1', 'D2', 'D3']);
    expect([...chainIds(rows, 'D4')]).toEqual(['D4']);
  });
  it('survives a cycle', () => {
    const cyc = [row(1, { waitsOn: ['D2'], unblocks: ['D2'] }), row(2, { waitsOn: ['D1'], unblocks: ['D1'] })];
    expect([...chainIds(cyc, 'D1')].sort()).toEqual(['D1', 'D2']);
  });
  it('links only rows tied to an in-queue item', () => {
    expect(rows.map((r) => hasChain(r, rows))).toEqual([true, true, true, false, false]);
  });
});

describe('filterQueue', () => {
  const f = (o: object) => ({ ...NO_QUEUE_FILTERS, ...o });
  const ids = (r: ReturnType<typeof filterQueue>) => r.items.map((i) => ('row' in i ? i.row.idLabel : `…${i.gap}`));
  it('shows everything with no filter', () => {
    expect(ids(filterQueue(rows, NO_QUEUE_FILTERS, ''))).toEqual(['D1', 'D2', 'D3', 'D4', 'T9']);
  });
  it('ORs inside a group and ANDs across groups', () => {
    expect(ids(filterQueue(rows, f({ levels: ['urgent', 'low'] }), ''))).toEqual(['…1', 'D2', '…1', 'D4', '…1']);
    expect(ids(filterQueue(rows, f({ levels: ['urgent', 'low'], sessions: ['P18'] }), ''))).toEqual(['…3', 'D4', '…1']);
    expect(ids(filterQueue(rows, f({ kinds: ['ticket'] }), ''))).toEqual(['…4', 'T9']);
  });
  it('filters by blocked state', () => {
    expect(ids(filterQueue(rows, f({ blocked: ['free'] }), ''))).toEqual(['D1', '…2', 'D4', '…1']);
    expect(ids(filterQueue(rows, f({ blocked: ['blocked'] }), ''))).toEqual(['…1', 'D2', 'D3', '…1', 'T9']);
  });
  it('keeps the computed position and reports the shown count', () => {
    const r = filterQueue(rows, f({ chain: 'D3' }), '');
    expect(r.shown).toBe(3);
    expect(r.items.filter((i) => 'row' in i).map((i) => ('row' in i ? i.row.position : 0))).toEqual([1, 2, 3]);
  });
  it('applies the search with the filters', () => {
    expect(ids(filterQueue(rows, NO_QUEUE_FILTERS, 'retry'))).toEqual(['D1', '…4']);
    expect(filterQueue(rows, f({ levels: ['low'] }), 'retry').shown).toBe(0);
  });
  it('ignores a chain whose row left the queue', () => {
    expect(filterQueue(rows, f({ chain: 'D77' }), '').shown).toBe(5);
    expect(liveFilters(rows, f({ chain: 'D77' })).chain).toBeNull();
  });
});

describe('matchesQuery', () => {
  it('matches id, session id, session title and title', () => {
    const r = row(1, { sessionLabel: 'P52', sessionTitle: 'offloading', title: 'Retry helper' });
    for (const q of ['d1', 'P52', 'offload', 'RETRY', '  retry ', '']) expect(matchesQuery(r, q)).toBe(true);
    expect(matchesQuery(r, 'zzz')).toBe(false);
  });
});

describe('helpers', () => {
  it('lists each session once, in queue order, with counts', () => {
    expect(queueSessions(rows)).toEqual([{ label: 'P17', title: 'offloading', count: 2 }, { label: 'P18', title: 'auth', count: 2 }]);
  });
  it('toggles without mutating', () => {
    const a = ['x'] as const;
    expect(toggledValue(a, 'y')).toEqual(['x', 'y']);
    expect(toggledValue(a, 'x')).toEqual([]);
    expect(a).toEqual(['x']);
  });
  it('reports an active filter', () => {
    expect(hasQueueFilters(NO_QUEUE_FILTERS)).toBe(false);
    expect(hasQueueFilters({ ...NO_QUEUE_FILTERS, chain: 'D1' })).toBe(true);
  });
});
