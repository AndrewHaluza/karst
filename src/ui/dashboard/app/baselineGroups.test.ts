import { describe, expect, it } from 'vitest';
import type { BaselineReviewRow } from '../baselineRows.js';
import { buildGroups, countRows, defaultFilter, defaultView, effectiveFilter, filterRows, groupKey, nextOpen, normaliseRows, pickSelected, stepFrom, themeOf } from './baselineGroups.js';

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
    expect(r).toMatchObject({ index: 3, path: 'tests/a.png', status: 'modified', decision: 'pending', oldSrc: '', reason: '' });
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

  it('skips the entries that are being decided in the same click', () => {
    expect(nextOpen(rows, 5, new Set([7]))).toBeNull();
    expect(nextOpen(rows, 5, new Set([6]))).toBe(7);
  });

  it('returns null when nothing else is pending', () => {
    expect(nextOpen(rows.filter((r) => r.index === 5), 5)).toBeNull();
    expect(nextOpen(rows.map((r) => ({ ...r, decision: 'approved' as const })), 5)).toBeNull();
  });
});

describe('effectiveFilter', () => {
  const none = { pending: 0, rejected: 1, approved: 1, all: 2 };
  const some = { pending: 1, rejected: 0, approved: 1, all: 2 };
  it('uses the default until the user picks a chip', () => {
    expect(effectiveFilter(null, some)).toBe('pending');
    expect(effectiveFilter(null, none)).toBe('all');
  });
  it('keeps the chosen chip, but never shows an empty Needs review', () => {
    expect(effectiveFilter('rejected', some)).toBe('rejected');
    expect(effectiveFilter('pending', none)).toBe('all');
  });
});

describe('pickSelected and stepFrom', () => {
  const rows = normaliseRows([row({ index: 4, label: 'a.png' }), row({ index: 9, label: 'b.png' }), row({ index: 2, label: 'c.png' })]);
  it('keeps the selected entry when it is visible, else the first visible one, else null', () => {
    expect(pickSelected(rows, 9)!.index).toBe(9);
    expect(pickSelected(rows, 77)!.index).toBe(4);
    expect(pickSelected(rows, null)!.index).toBe(4);
    expect(pickSelected([], 4)).toBeNull();
  });
  it('steps to the next and previous visible entry, stopping at the ends', () => {
    expect(stepFrom(rows, 4, 1)).toBe(9);
    expect(stepFrom(rows, 4, -1)).toBe(4);
    expect(stepFrom(rows, 2, 1)).toBe(2);
    expect(stepFrom(rows, 2, -1)).toBe(9);
    expect(stepFrom([], 2, 1)).toBeNull();
  });
});
