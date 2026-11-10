import { describe, expect, it } from 'vitest';
import type { BaselineReviewRow } from '../baselineRows.js';
import { buildGroups, countRows, defaultFilter, defaultView, filterRows, groupKey, nextOpen, normaliseRows, themeOf } from './baselineGroups.js';

const row = (over: Partial<BaselineReviewRow> & { index: number; label: string }): BaselineReviewRow => ({
  path: `tests/${over.label}`,
  status: 'modified',
  oldSrc: 'old.png',
  newSrc: 'new.png',
  decision: 'pending',
  reason: null,
  ...over,
});

describe('groupKey and themeOf', () => {
  it('groups a theme-folder label by the rest of its path', () => {
    expect(groupKey('dark/dashboard.png')).toBe('dashboard.png');
    expect(themeOf('dark/dashboard.png')).toBe('dark');
    expect(groupKey('dark-grayscale/a/b.png')).toBe('a/b.png');
    expect(groupKey('dark-reduced-motion/x.png')).toBe('x.png');
    expect(groupKey('light/x.png')).toBe('x.png');
    expect(groupKey('hc/x.png')).toBe('x.png');
  });

  it('keeps any other label as its own group, with no theme', () => {
    expect(groupKey('catalog/dashboard-failed.png')).toBe('catalog/dashboard-failed.png');
    expect(themeOf('catalog/dashboard-failed.png')).toBe('');
    expect(groupKey('layout-known-failures.json')).toBe('layout-known-failures.json');
    expect(groupKey('darker/x.png')).toBe('darker/x.png');
  });
});

describe('normaliseRows', () => {
  it('clamps unknown enums and coerces the index', () => {
    const [r] = normaliseRows([{ ...row({ index: 3.9, label: 'a.png' }), status: 'weird' as never, decision: 'odd' as never, oldSrc: null }]);
    expect(r).toMatchObject({ index: 3, status: 'modified', decision: 'pending', oldSrc: '', reason: '' });
  });
});

describe('buildGroups', () => {
  const rows = normaliseRows([
    row({ index: 0, label: 'dark/a.png' }),
    row({ index: 1, label: 'light/a.png', decision: 'approved' }),
    row({ index: 2, label: 'catalog/b.png', decision: 'rejected', reason: 'bad' }),
    row({ index: 3, label: 'dark/c.png', status: 'added', oldSrc: null }),
  ]);

  it('makes one group per screenshot name in first-seen order, with its themes', () => {
    const groups = buildGroups(rows);
    expect(groups.map((g) => g.name)).toEqual(['a.png', 'catalog/b.png', 'c.png']);
    expect(groups[0]!.rows.map((r) => r.index)).toEqual([0, 1]);
  });

  it('derives the group decision: rejected beats pending beats approved', () => {
    const groups = buildGroups(rows);
    expect(groups[0]!.decision).toBe('pending');
    expect(groups[1]!.decision).toBe('rejected');
    expect(buildGroups(rows.filter((r) => r.index === 1))[0]!.decision).toBe('approved');
  });
});

describe('countRows and filterRows', () => {
  const rows = normaliseRows([
    row({ index: 0, label: 'a.png' }),
    row({ index: 1, label: 'b.png', decision: 'approved' }),
    row({ index: 2, label: 'c.png', decision: 'rejected' }),
    row({ index: 3, label: 'd.png' }),
  ]);

  it('counts each decision and the total', () => {
    expect(countRows(rows)).toEqual({ pending: 2, rejected: 1, approved: 1, all: 4 });
  });

  it('filters by decision; all keeps every row', () => {
    expect(filterRows(rows, 'pending').map((r) => r.index)).toEqual([0, 3]);
    expect(filterRows(rows, 'rejected').map((r) => r.index)).toEqual([2]);
    expect(filterRows(rows, 'approved').map((r) => r.index)).toEqual([1]);
    expect(filterRows(rows, 'all')).toHaveLength(4);
  });

  it('defaults the filter to pending, and to all when nothing is pending', () => {
    expect(defaultFilter(countRows(rows))).toBe('pending');
    expect(defaultFilter({ pending: 0, rejected: 1, approved: 1, all: 2 })).toBe('all');
  });
});

describe('defaultView', () => {
  it('is Difference for modified, New for added, Old for deleted', () => {
    expect(defaultView('modified')).toBe('diff');
    expect(defaultView('added')).toBe('new');
    expect(defaultView('deleted')).toBe('old');
  });
});

describe('nextOpen', () => {
  const rows = normaliseRows([
    row({ index: 5, label: 'a.png' }),
    row({ index: 6, label: 'b.png', decision: 'approved' }),
    row({ index: 7, label: 'c.png' }),
  ]);

  it('returns the next pending entry after the given one, wrapping around', () => {
    expect(nextOpen(rows, 5)).toBe(7);
    expect(nextOpen(rows, 7)).toBe(5);
  });

  it('returns null when nothing else is pending', () => {
    expect(nextOpen(rows.filter((r) => r.index === 5), 5)).toBeNull();
    expect(nextOpen(rows.map((r) => ({ ...r, decision: 'approved' as const })), 5)).toBeNull();
  });
});
