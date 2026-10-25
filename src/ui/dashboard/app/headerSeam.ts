/**
 * Transitional seam between the React header (app/Header.tsx) and the vanilla page script (removed in
 * migration Phase 12, with the rest of the vanilla script). Two things the header touches still live
 * in `webview.html`: the outside-click dismissal (vanilla controls call `closePopovers()`) and the
 * ticket-data drawer (an overlay, Phase 11). Both are window events, so React never reaches into page
 * functions. (The in-flight ship request the stage rail's Ship button shares was a third; both ends are
 * React now, so it is `pendingOps.ts`.)
 */
export const CLOSE_POPOVERS_EVENT = 'karst:closePopovers';
export const OPEN_TICKET_DATA_EVENT = 'karst:openTicketData';

function listen<T>(name: string, listener: (detail: T) => void): () => void {
  const handler = (e: Event): void => listener((e as CustomEvent<T>).detail);
  window.addEventListener(name, handler);
  return () => window.removeEventListener(name, handler);
}

/** Page to React: a vanilla control was clicked, which is outside every header popover. */
export const onClosePopovers = (listener: () => void): (() => void) => listen<void>(CLOSE_POPOVERS_EVENT, listener);

/** React to the page: open the ticket-data drawer (the page remembers the focused trigger). */
export function announceOpenTicketData(): void {
  window.dispatchEvent(new CustomEvent(OPEN_TICKET_DATA_EVENT));
}
