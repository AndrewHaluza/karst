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

/**
 * When fewer than this many rows sit past a cap, show them all rather than
 * trading 1-2 rows for a button.
 */
export const SHOW_ALL_BELOW = 3;

/**
 * The semantic form of a cap: ship EVERY row, marking the ones past `limit`
 * `collapsed` so the webview can hide them until the reader expands. Nothing is
 * dropped, so an expanded list replays the exact original sequence.
 *
 * Below the `SHOW_ALL_BELOW` floor the rows come back untouched and uncollapsed:
 * hiding one or two rows behind a control costs more space than it saves.
 */
export function collapseAfter(rows: readonly EvidenceRow[], limit: number): EvidenceRow[] {
  if (rows.length - limit < SHOW_ALL_BELOW) return [...rows];
  return rows.map((r, i) => (i < limit ? r : { ...r, collapsed: true }));
}

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
