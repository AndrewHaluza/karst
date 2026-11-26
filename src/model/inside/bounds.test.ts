import { describe, expect, it, vi } from 'vitest';
import type { EvidenceRow, TypedInsideAction } from './types.js';
import { SHOW_ALL_BELOW, boundedEvidenceRows, collapseAfter } from './bounds.js';

const rows = (count: number): EvidenceRow[] =>
  Array.from({ length: count }, (_, i) => ({ status: 'pass', label: `repo-${i + 1}` }));

describe('boundedEvidenceRows', () => {
  it('returns every row and does not mint a continuation at or below the limit', () => {
    const continuation = vi.fn<(_: readonly EvidenceRow[]) => TypedInsideAction>();
    expect(boundedEvidenceRows(rows(6), 6, continuation)).toEqual(rows(6));
    expect(continuation).not.toHaveBeenCalled();
  });

  it('returns six rows plus one actionable remainder and hands all rows to the host seam', () => {
    const action: TypedInsideAction = {
      actionId: 'snapshot-7:action-0',
      kind: 'open-bounded-evidence',
    };
    const continuation = vi.fn(() => action);
    const all = rows(20);
    const view = boundedEvidenceRows(all, 6, continuation);

    expect(view).toHaveLength(7);
    expect(view.slice(0, 6)).toEqual(all.slice(0, 6));
    expect(view[6]).toEqual({
      status: 'note',
      label: 'more',
      detail: '+14 more',
      action,
    });
    expect(continuation).toHaveBeenCalledOnce();
    expect(continuation).toHaveBeenCalledWith(all);
  });
});

describe('collapseAfter', () => {
  const limit = 6;

  const uncollapsed = (view: readonly EvidenceRow[]): EvidenceRow[] =>
    view.filter((r) => !r.collapsed);
  const collapsed = (view: readonly EvidenceRow[]): EvidenceRow[] =>
    view.filter((r) => r.collapsed);

  it('returns every row uncollapsed when nothing sits past the cap', () => {
    expect(SHOW_ALL_BELOW).toBe(3);
    expect(collapseAfter(rows(limit), limit)).toEqual(rows(limit));
    expect(collapseAfter(rows(limit - 2), limit)).toEqual(rows(limit - 2));
  });

  it('returns every row uncollapsed when one row would be hidden', () => {
    const view = collapseAfter(rows(limit + 1), limit);
    expect(view).toEqual(rows(limit + 1));
    expect(view.some((r) => r.collapsed)).toBe(false);
  });

  it('returns every row uncollapsed when two rows would be hidden', () => {
    const view = collapseAfter(rows(limit + 2), limit);
    expect(view).toEqual(rows(limit + 2));
    expect(view.some((r) => r.collapsed)).toBe(false);
  });

  it('collapses the rows past the cap once three would be hidden, keeping their fields', () => {
    const input = rows(limit + 3).map((r, i) => ({
      ...r,
      detail: `detail ${i}`,
      repo: `repo/${i}`,
    }));
    const snapshot = JSON.parse(JSON.stringify(input)) as EvidenceRow[];
    const view = collapseAfter(input, limit);

    expect(view).toHaveLength(limit + 3);
    expect(uncollapsed(view)).toEqual(input.slice(0, limit));
    expect(view.slice(0, limit).some((r) => 'collapsed' in r)).toBe(false);
    expect(collapsed(view)).toEqual(
      input.slice(limit).map((r) => ({ ...r, collapsed: true })),
    );
    // Order is preserved exactly: expanding replays the input sequence.
    expect(view.map((r) => r.label)).toEqual(input.map((r) => r.label));
    // The caller's rows are never mutated.
    expect(input).toEqual(snapshot);
  });

  it('collapses every row past the cap and reports the exact counts', () => {
    const view = collapseAfter(rows(limit + 5), limit);
    expect(view).toHaveLength(limit + 5);
    expect(uncollapsed(view)).toHaveLength(limit);
    expect(collapsed(view)).toHaveLength(5);
    expect(view.slice(limit).map((r) => r.label)).toEqual(
      rows(limit + 5).slice(limit).map((r) => r.label),
    );
  });
});
