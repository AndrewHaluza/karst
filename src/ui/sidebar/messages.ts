import type { ActionResultMessage } from '../../model/actionResult.js';
import type { SidebarState } from './state.js';
import { FACETS, type FacetKey } from './facets.js';

/**
 * Message protocol for the sidebar ticket-list webview. The webview is a trust
 * boundary, so inbound messages are narrowed by `parseSidebarMessage` before they
 * reach any action (ticket ids must be numbers, facets must be known keys).
 */

/** Webview → host. Row actions carry a numeric `ticketId` (→ `ticketIdArg`). */
export type SidebarWebviewMessage =
  | { type: 'toggle-facet'; facet: FacetKey }
  | { type: 'set-filter'; query: string }
  | { type: 'refresh' }
  | { type: 'request-state' }
  | { type: 'create' }
  | { type: 'open-settings' }
  | { type: 'open-ticket'; ticketId: number }
  | { type: 'open-dashboard'; ticketId: number }
  | { type: 'spin'; ticketId: number }
  | { type: 'open-session'; ticketId: number }
  | { type: 'edit'; ticketId: number }
  | { type: 'archive'; ticketId: number }
  | { type: 'unarchive'; ticketId: number }
  | { type: 'delete'; ticketId: number };

/**
 * Host → webview. The old channel was ONLY `state` — `spin`/`archive`/`delete`
 * and every other row action had no way to report an outcome (UI-R13). Every
 * action now reports through the single `action-result` seam, which is what
 * lets a row's icon button settle into a visible success/failure instead of
 * being fire-and-forget.
 */
export type SidebarHostMessage = { type: 'state'; state: SidebarState } | ActionResultMessage;

/**
 * Host-side effects the sidebar can trigger (executeCommand passthrough). A
 * `void` return acks the request as soon as it is accepted; a returned promise
 * is awaited and its settlement becomes the terminal `action-result`
 * (docs/ui/DESIGN-SYSTEM.md §5.3, UI-R13). This is a type WIDENING from
 * `() => void` — every existing implementation still satisfies it.
 */
export interface SidebarActions {
  toggleFacet(facet: FacetKey): void | Promise<void>;
  setFilter(query: string): void | Promise<void>;
  refresh(): void | Promise<void>;
  requestState(): void | Promise<void>;
  create(): void | Promise<void>;
  openSettings(): void | Promise<void>;
  openTicket(ticketId: number): void | Promise<void>;
  openDashboard(ticketId: number): void | Promise<void>;
  spin(ticketId: number): void | Promise<void>;
  openSession(ticketId: number): void | Promise<void>;
  edit(ticketId: number): void | Promise<void>;
  archive(ticketId: number): void | Promise<void>;
  unarchive(ticketId: number): void | Promise<void>;
  delete(ticketId: number): void | Promise<void>;
}

const FACET_KEYS = new Set<string>(FACETS.map((f) => f.key));

/**
 * Narrow an untrusted webview message. Validates the discriminant and its
 * companion field — `ticketId` must be a finite number, `facet` a known key,
 * `query` a string — before it reaches an action. Returns null for anything
 * malformed so the router can drop it safely.
 */
export function parseSidebarMessage(raw: unknown): SidebarWebviewMessage | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const m = raw as Record<string, unknown>;
  const id = typeof m.ticketId === 'number' && Number.isFinite(m.ticketId);
  switch (m.type) {
    case 'refresh':
    case 'request-state':
    case 'create':
    case 'open-settings':
      return { type: m.type };
    case 'toggle-facet':
      return typeof m.facet === 'string' && FACET_KEYS.has(m.facet)
        ? { type: 'toggle-facet', facet: m.facet as FacetKey }
        : null;
    case 'set-filter':
      return typeof m.query === 'string' ? { type: 'set-filter', query: m.query } : null;
    case 'open-ticket':
    case 'open-dashboard':
    case 'spin':
    case 'open-session':
    case 'edit':
    case 'archive':
    case 'unarchive':
    case 'delete':
      return id ? ({ type: m.type, ticketId: m.ticketId as number } as SidebarWebviewMessage) : null;
    default:
      return null;
  }
}

/**
 * Dispatch an ALREADY-PARSED message to its action, returning whatever the
 * action returns. The single dispatch seam (panel.ts) parses `raw` once, reads
 * its `requestId` off the raw shape (which this narrower deliberately never
 * sees), and wraps this call in `reportAction` so the caller can await a real
 * outcome and report exactly one terminal `action-result` (UI-R13). Mirrors
 * welcome/messages.ts's `routeWelcomeAction`.
 */
export function routeSidebarAction(msg: SidebarWebviewMessage, actions: SidebarActions): void | Promise<void> {
  switch (msg.type) {
    case 'toggle-facet':
      return actions.toggleFacet(msg.facet);
    case 'set-filter':
      return actions.setFilter(msg.query);
    case 'refresh':
      return actions.refresh();
    case 'request-state':
      return actions.requestState();
    case 'create':
      return actions.create();
    case 'open-settings':
      return actions.openSettings();
    case 'open-ticket':
      return actions.openTicket(msg.ticketId);
    case 'open-dashboard':
      return actions.openDashboard(msg.ticketId);
    case 'spin':
      return actions.spin(msg.ticketId);
    case 'open-session':
      return actions.openSession(msg.ticketId);
    case 'edit':
      return actions.edit(msg.ticketId);
    case 'archive':
      return actions.archive(msg.ticketId);
    case 'unarchive':
      return actions.unarchive(msg.ticketId);
    case 'delete':
      return actions.delete(msg.ticketId);
  }
}
