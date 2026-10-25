/**
 * Transitional seam between the React Pull requests panel and the vanilla page script (removed in
 * migration Phase 12, with the rest of the vanilla script). Two controls the panel shares with the
 * page are still vanilla: the stage rail's needs-you Merge button and the stage menu's "Send CI
 * failure" item. The page keeps the in-flight maps those two read (`mergeRequests`,
 * `ciFailureRequestId`) and settles them on the next settling state push, so the panel and the page
 * tell each other when one of them begins, and a second click can never open a second dialog.
 */
export const PR_BEGIN_EVENT = 'karst:prBegin';
export const PR_PENDING_EVENT = 'karst:prPending';

/** React to the page: a control of the panel went pending; the page records its request id. */
export type PrBegin =
  | { readonly kind: 'merge'; readonly repo: string; readonly requestId: string }
  | { readonly kind: 'ci-failure'; readonly requestId: string };

/** Page to React: a control of the page went pending; the panel shows the same operation busy. */
export type PrPending = { readonly kind: 'merge'; readonly repo: string } | { readonly kind: 'ci-failure' };

export function announceBegin(detail: PrBegin): void {
  window.dispatchEvent(new CustomEvent<PrBegin>(PR_BEGIN_EVENT, { detail }));
}

export function onPagePending(listener: (detail: PrPending) => void): () => void {
  const handler = (e: Event): void => listener((e as CustomEvent<PrPending>).detail);
  window.addEventListener(PR_PENDING_EVENT, handler);
  return () => window.removeEventListener(PR_PENDING_EVENT, handler);
}
