export interface Page<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

export function clampPageSize(size: number | undefined): number {
  if (size === undefined || !Number.isInteger(size) || size < 1) return DEFAULT_PAGE_SIZE;
  return Math.min(size, MAX_PAGE_SIZE);
}

/** Pages start at 1. A page outside the range is moved to the nearest valid page. */
export function paginate<T>(items: readonly T[], page: number, size?: number): Page<T> {
  const pageSize = clampPageSize(size);
  const totalPages = Math.max(1, Math.ceil(items.length / pageSize));
  const current = Math.min(Math.max(1, page), totalPages);
  const start = current * pageSize;
  return { items: items.slice(start, start + pageSize), page: current, pageSize, total: items.length, totalPages };
}

export function pageRange(p: Page<unknown>): string {
  if (p.total === 0) return '0 of 0';
  const first = (p.page - 1) * p.pageSize + 1;
  const last = Math.min(p.page * p.pageSize, p.total);
  return `${first}-${last} of ${p.total}`;
}
