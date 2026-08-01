import type { ActionResultMessage } from '../../model/actionResult.js';
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

/**
 * Every action now reports through the single `action-result` seam (UI-R13),
 * which is what lets the four filter/navigation controls show pending and a
 * terminal outcome instead of firing at the host with no acknowledgment.
 */
export type UsageHostMessage = { type: 'state'; state: UsageState } | ActionResultMessage;

/**
 * The host-side effects the token-usage view can trigger. A `void` return acks
 * the request as soon as it is accepted; a returned promise is awaited and its
 * settlement becomes the terminal `action-result` (docs/ui/DESIGN-SYSTEM.md
 * §5.3, UI-R13). This is a type widening from `() => void` — every existing
 * implementation still satisfies it.
 */
export interface UsageActions {
  requestState(): void | Promise<void>;
  setRange(range: string): void | Promise<void>;
  setSort(sort: UsageSort): void | Promise<void>;
  setPage(offset: number): void | Promise<void>;
  openDashboard(ticketId: number): void | Promise<void>;
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

/**
 * Dispatch an ALREADY-PARSED message to its action, returning whatever the
 * action returns. The single dispatch seam (panel.ts) parses the raw message
 * once, reads its `requestId` off the raw shape (which this narrower
 * deliberately never sees), and wraps this call in `reportAction` so the
 * caller can await a real outcome and report exactly one terminal
 * `action-result` (UI-R13).
 */
export function routeUsageAction(msg: UsageWebviewMessage, actions: UsageActions): void | Promise<void> {
  switch (msg.type) {
    case 'request-state':
      return actions.requestState();
    case 'set-range':
      return actions.setRange(msg.range);
    case 'set-sort':
      return actions.setSort(msg.sort);
    case 'set-page':
      return actions.setPage(msg.offset);
    case 'open-dashboard':
      return actions.openDashboard(msg.ticketId);
  }
}
