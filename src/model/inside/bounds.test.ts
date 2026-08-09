import { describe, expect, it, vi } from 'vitest';
import type { EvidenceRow, TypedInsideAction } from './types.js';
import { boundedEvidenceRows } from './bounds.js';

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
