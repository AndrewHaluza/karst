/**
 * The evidence cap every inside reducer applies before it renders, and the
 * single rule that "bounded" means: the first `limit` items, plus the count of
 * what was withheld. A view never renders a bounded list without being able to
 * say what it held back — `remaining` is how it does.
 */
export function bounded<T>(
  items: readonly T[],
  limit: number,
): { shown: readonly T[]; remaining: number } {
  return { shown: items.slice(0, limit), remaining: Math.max(0, items.length - limit) };
}

import type { EvidenceRow, TypedInsideAction } from './types.js';

/** Bound repository evidence while retaining a host-owned continuation. */
export function boundedEvidenceRows(
  rows: readonly EvidenceRow[],
  limit: number,
  continuation?: (allRows: readonly EvidenceRow[]) => TypedInsideAction | undefined,
): EvidenceRow[] {
  const result = bounded(rows, limit);
  const shown = [...result.shown];
  if (result.remaining === 0) return shown;
  const action = continuation?.(rows);
  shown.push({
    status: 'note',
    label: 'more',
    detail: `+${result.remaining} more`,
    ...(action ? { action } : {}),
  });
  return shown;
}
