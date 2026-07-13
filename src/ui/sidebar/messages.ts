import type { SidebarState } from './state.js';
import { FACETS, type FacetKey } from './facets.js';

/**
 * Message protocol for the sidebar ticket-list webview. The webview is a trust
 * boundary, so inbound messages are narrowed by `parseSidebarMessage` before they
 * reach any action (ticket ids must be numbers, facets must be known keys).
 */

/** Webview → host. Row actions carry a numeric `ticketId` (→ `ticketIdArg`). */
export type SidebarWebviewMessage =
  | { type: 'set-facet'; facet: FacetKey }
  | { type: 'set-filter'; query: string }
  | { type: 'refresh' }
  | { type: 'request-state' }
  | { type: 'create' }
  | { type: 'open-settings' }
  | { type: 'open-dashboard'; ticketId: number }
  | { type: 'spin'; ticketId: number }
  | { type: 'open-session'; ticketId: number }
  | { type: 'edit'; ticketId: number }
  | { type: 'archive'; ticketId: number }
  | { type: 'unarchive'; ticketId: number }
  | { type: 'delete'; ticketId: number };

/** Host → webview. */
export type SidebarHostMessage = { type: 'state'; state: SidebarState };

/** Host-side effects the sidebar can trigger (executeCommand passthrough). */
export interface SidebarActions {
  setFacet(facet: FacetKey): void;
  setFilter(query: string): void;
  refresh(): void;
  requestState(): void;
  create(): void;
  openSettings(): void;
  openDashboard(ticketId: number): void;
  spin(ticketId: number): void;
  openSession(ticketId: number): void;
  edit(ticketId: number): void;
  archive(ticketId: number): void;
  unarchive(ticketId: number): void;
  delete(ticketId: number): void;
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
    case 'set-facet':
      return typeof m.facet === 'string' && FACET_KEYS.has(m.facet)
        ? { type: 'set-facet', facet: m.facet as FacetKey }
        : null;
    case 'set-filter':
      return typeof m.query === 'string' ? { type: 'set-filter', query: m.query } : null;
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

/** Parse then dispatch a webview message to the matching action. No-op if bad. */
export function routeSidebarAction(raw: unknown, actions: SidebarActions): void {
  const msg = parseSidebarMessage(raw);
  if (!msg) return;
  switch (msg.type) {
    case 'set-facet':
      return actions.setFacet(msg.facet);
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
