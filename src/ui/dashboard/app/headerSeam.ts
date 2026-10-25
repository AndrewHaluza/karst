/**
 * Transitional seam between the React header (app/Header.tsx) and the vanilla page script (removed in
 * migration Phase 12, with the rest of the vanilla script). Three things the header touches still live
 * in `webview.html`: the outside-click dismissal (vanilla controls call `closePopovers()`), the
 * ticket-data drawer (an overlay, Phase 11) and the in-flight ship request the stage rail's Ship button
 * shares (`shipRequestId`, Phase 9). All are window events, so React never reaches into page functions.
 */
export const CLOSE_POPOVERS_EVENT = 'karst:closePopovers';
export const OPEN_TICKET_DATA_EVENT = 'karst:openTicketData';
export const SHIP_BEGIN_EVENT = 'karst:shipBegin';
export const SHIP_STATE_EVENT = 'karst:shipState';

/** Page to React: the page's in-flight ship request (header or rail started it) and the post-ship flash. */
export interface ShipState {
  readonly inFlight: boolean;
  readonly shipped: boolean;
}

function listen<T>(name: string, listener: (detail: T) => void): () => void {
  const handler = (e: Event): void => listener((e as CustomEvent<T>).detail);
  window.addEventListener(name, handler);
  return () => window.removeEventListener(name, handler);
}

/** Page to React: a vanilla control was clicked, which is outside every header popover. */
export const onClosePopovers = (listener: () => void): (() => void) => listen<void>(CLOSE_POPOVERS_EVENT, listener);

export const onShipState = (listener: (detail: ShipState) => void): (() => void) => listen<ShipState>(SHIP_STATE_EVENT, listener);

/** React to the page: open the ticket-data drawer (the page remembers the focused trigger). */
export function announceOpenTicketData(): void {
  window.dispatchEvent(new CustomEvent(OPEN_TICKET_DATA_EVENT));
}

/** React to the page: Confirm ship went pending; the page records the request id the rail's Ship button shares. */
export function announceShipBegin(requestId: string): void {
  window.dispatchEvent(new CustomEvent<string>(SHIP_BEGIN_EVENT, { detail: requestId }));
}
