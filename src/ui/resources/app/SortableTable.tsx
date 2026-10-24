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
  /** Extra header/cell class (width hints). */
  readonly cls?: string;
  /** Sort value; `-1` means "unmeasured" and always sorts last. */
  readonly sortValue: (row: T) => string | number;
  readonly cell: (row: T) => ReactNode;
  /** Cell class override (ellipsis etc.). */
  readonly cellCls?: string;
}

interface SortState {
  readonly key: string | null;
  readonly dir: 'asc' | 'desc' | null;
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
    setSort((cur) => {
      if (cur.key !== key) return { key, dir: 'asc' };
      if (cur.dir === null) return { key, dir: 'asc' };
      return cur.dir === 'asc' ? { key, dir: 'desc' } : { key: null, dir: null };
    });
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
                  aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : undefined}
                >
                  <Button variant="text" onClick={() => cycle(c.key)}>
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
                  <td key={c.key} className={cls || undefined}>
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
