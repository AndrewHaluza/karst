/**
 * One posting control's pending state, via the design-system runtime's pending
 * primitives (`karstRequestId` + `karstBeginPending`) exactly as the sidebar's
 * `fire` does (UI-R11–R14): pending on click, non-re-triggerable, settled by the
 * host's `action-result` (the page's vanilla handler calls `karstSettle`), with
 * the runtime's watchdog as the backstop.
 */
import { useCallback, type MouseEvent } from 'react';

interface PendingRuntime {
  karstRequestId(): string;
  karstIsPending(el: Element): boolean;
  karstBeginPending(el: Element, requestId: string): void;
}

/** `post` receives the request id to stamp on the outbound message. */
export function usePendingAction(post: (requestId: string) => void): (e: MouseEvent<HTMLButtonElement>) => void {
  return useCallback(
    (e) => {
      const el = e.currentTarget;
      const rt = globalThis as unknown as PendingRuntime;
      if (rt.karstIsPending(el) || el.disabled) {
        e.preventDefault();
        return;
      }
      const requestId = rt.karstRequestId();
      rt.karstBeginPending(el, requestId);
      post(requestId);
    },
    [post],
  );
}
