/**
 * A table whose header cells are real sort buttons (UI-R09 — never a click on
 * `<th>`). Sort order is local presentation: default → asc → desc → default.
 * Sorting never posts.
 */
import { useState, type ReactNode } from 'react';
import { Button } from '../../settings/app/primitives/Button.js';

export interface Column<T> {
  readonly key: string;
  readonly label: string;
  readonly num: boolean;
  /**
   * Tier priority (@ui:RD-TIERS, RS-11): 1 always shows, 2 shows except in a
   * card, 3 hides at the narrow tier. Default 1.
   */
  readonly priority?: 1 | 2 | 3;
  /** Extra header/cell class (width hints). */
  readonly cls?: string;
  /** Sort value; `-1` means "unmeasured" and always sorts last. */
  readonly sortValue: (row: T) => string | number;
  readonly cell: (row: T) => ReactNode;
  /** Cell class override (ellipsis etc.). */
  readonly cellCls?: string;
}

export interface SortState {
  readonly key: string | null;
  readonly dir: 'asc' | 'desc' | null;
}

/**
 * The next sort state for one column: a fresh column starts with the most
 * useful end — descending for a number (the biggest first, RS-21), ascending
 * for text — then flips once and clears.
 */
export function nextSort(cur: SortState, key: string, num: boolean): SortState {
  const first = num ? 'desc' : 'asc';
  const second = num ? 'asc' : 'desc';
  if (cur.key !== key) return { key, dir: first };
  if (cur.dir === first) return { key, dir: second };
  if (cur.dir === second) return { key: null, dir: null };
  return { key, dir: first };
}

function sorted<T>(rows: readonly T[], cols: readonly Column<T>[], sort: SortState): readonly T[] {
  if (!sort.key || !sort.dir) return rows;
  const col = cols.find((c) => c.key === sort.key);
  if (!col) return rows;
  const dir = sort.dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const va = col.sortValue(a);
    const vb = col.sortValue(b);
    if (va === vb) return 0;
    if (va === -1) return 1;
    if (vb === -1) return -1;
    if (typeof va === 'string' && typeof vb === 'string') return va.localeCompare(vb) * dir;
    return ((va as number) - (vb as number)) * dir;
  });
}

export function SortableTable<T>({
  rows,
  columns,
  rowKey,
  tableCls,
  ids,
}: {
  rows: readonly T[];
  columns: readonly Column<T>[];
  rowKey: (row: T) => string;
  tableCls?: string;
  /** DOM ids for the head and body groups (stable anchors for the layout ledger and tests). */
  ids?: { readonly head: string; readonly body: string };
}) {
  const [sort, setSort] = useState<SortState>({ key: null, dir: null });
  const cycle = (key: string): void =>
    setSort((cur) => nextSort(cur, key, columns.find((c) => c.key === key)?.num ?? false));
  return (
    <div className="tscroll">
      <table className={tableCls}>
        <thead id={ids?.head}>
          <tr>
            {columns.map((c) => {
              const active = sort.key === c.key;
              const cls = [c.cls, c.num ? 'num' : null].filter(Boolean).join(' ');
              return (
                <th
                  key={c.key}
                  className={cls || undefined}
                  data-priority={c.priority ?? 1}
                  aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : undefined}
                >
                  <Button variant="text" className="thsort" onClick={() => cycle(c.key)}>
                    {c.label}
                    {active ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : ''}
                  </Button>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody id={ids?.body}>
          {sorted(rows, columns, sort).map((row) => (
            <tr key={rowKey(row)}>
              {columns.map((c) => {
                const cls = [c.cellCls ?? c.cls, c.num ? 'num' : null].filter(Boolean).join(' ');
                return (
                  <td key={c.key} className={cls || undefined} data-priority={c.priority ?? 1} data-label={c.label}>
                    {c.cell(row)}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
