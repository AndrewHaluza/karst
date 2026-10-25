/**
 * Transitional seam between the React Pull requests panel and the vanilla page script (removed in
 * migration Phase 12, with the rest of the vanilla script). One control the panel shares with the page is
 * still vanilla: the Inside stage menu's "Send CI failure" item (Phase 10). The page keeps the in-flight id
 * it reads (`ciFailureRequestId`) and settles it on the next settling state push, so the panel and the page
 * tell each other when one of them begins, and a second click can never open a second dialog.
 *
 * (Merge was a second shared control, with the stage rail's Merge button. Both ends are React now, so it is
 * held in `pendingOps.ts` and no longer crosses this seam.)
 */
export const PR_BEGIN_EVENT = 'karst:prBegin';
export const PR_PENDING_EVENT = 'karst:prPending';

/** React to the page: the panel's Send CI failure went pending; the page records its request id. */
export interface PrBegin {
  readonly kind: 'ci-failure';
  readonly requestId: string;
}

export function announceBegin(detail: PrBegin): void {
  window.dispatchEvent(new CustomEvent<PrBegin>(PR_BEGIN_EVENT, { detail }));
}

/** Page to React: the stage menu's Send CI failure went pending; the panel shows the same operation busy. */
export function onPagePending(listener: () => void): () => void {
  window.addEventListener(PR_PENDING_EVENT, listener);
  return () => window.removeEventListener(PR_PENDING_EVENT, listener);
}
