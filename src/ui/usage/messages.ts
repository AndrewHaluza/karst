import type { UsageState } from './state.js';
import { USAGE_RANGES, USAGE_SORTS, type UsageSort } from '../../store/tokenUsageQuery.js';

/**
 * Message protocol for the token-usage webview.
 *
 * The webview is a trust boundary, so every inbound message is narrowed here
 * before it reaches an action: a range must be a known preset id, a sort a known
 * key, a page offset a non-negative integer, a ticket id a finite number. The
 * range and sort go on to build a SQL query, which is exactly why they are
 * checked against the closed sets rather than passed through as strings.
 *
 * `open-dashboard` carries a ticket id and nothing else — the host resolves the
 * ticket itself, so a crafted message cannot name a path, a URL, or a project.
 */

export type UsageWebviewMessage =
  | { type: 'request-state' }
  | { type: 'set-range'; range: string }
  | { type: 'set-sort'; sort: UsageSort }
  | { type: 'set-page'; offset: number }
  | { type: 'open-dashboard'; ticketId: number };

export type UsageHostMessage = { type: 'state'; state: UsageState };

/** The host-side effects the token-usage view can trigger. */
export interface UsageActions {
  requestState(): void;
  setRange(range: string): void;
  setSort(sort: UsageSort): void;
  setPage(offset: number): void;
  openDashboard(ticketId: number): void;
}

const RANGE_IDS = new Set<string>(USAGE_RANGES.map((r) => r.id));
const SORT_IDS = new Set<string>(USAGE_SORTS);

/** Narrow an untrusted webview message; null for anything malformed. */
export function parseUsageMessage(raw: unknown): UsageWebviewMessage | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const m = raw as Record<string, unknown>;
  switch (m.type) {
    case 'request-state':
      return { type: 'request-state' };
    case 'set-range':
      return typeof m.range === 'string' && RANGE_IDS.has(m.range)
        ? { type: 'set-range', range: m.range }
        : null;
    case 'set-sort':
      return typeof m.sort === 'string' && SORT_IDS.has(m.sort)
        ? { type: 'set-sort', sort: m.sort as UsageSort }
        : null;
    case 'set-page':
      return typeof m.offset === 'number' && Number.isInteger(m.offset) && m.offset >= 0
        ? { type: 'set-page', offset: m.offset }
        : null;
    case 'open-dashboard':
      return typeof m.ticketId === 'number' && Number.isFinite(m.ticketId)
        ? { type: 'open-dashboard', ticketId: m.ticketId }
        : null;
    default:
      return null;
  }
}

/** Route a narrowed message to its action. Unknown messages are dropped. */
export function routeUsageAction(raw: unknown, actions: UsageActions): void {
  const msg = parseUsageMessage(raw);
  if (!msg) return;
  switch (msg.type) {
    case 'request-state':
      actions.requestState();
      return;
    case 'set-range':
      actions.setRange(msg.range);
      return;
    case 'set-sort':
      actions.setSort(msg.sort);
      return;
    case 'set-page':
      actions.setPage(msg.offset);
      return;
    case 'open-dashboard':
      actions.openDashboard(msg.ticketId);
  }
}
