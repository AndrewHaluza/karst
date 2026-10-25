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

type Clicked = MouseEvent<HTMLElement>;

/**
 * Begins the runtime's pending state on the clicked control and returns the request id, or null (after
 * swallowing the click) when it is already pending or disabled. For controls whose wire message carries
 * no request id and which settle on a state push: they keep the id themselves.
 */
export function beginPending(e: Clicked): string | null {
  const el = e.currentTarget as HTMLElement & { disabled?: boolean };
  const rt = globalThis as unknown as PendingRuntime;
  if (rt.karstIsPending(el) || el.disabled) {
    e.preventDefault();
    return null;
  }
  const requestId = rt.karstRequestId();
  rt.karstBeginPending(el, requestId);
  return requestId;
}

/** `post` receives the request id to stamp on the outbound message. */
export function usePendingAction(post: (requestId: string) => void): (e: Clicked) => void {
  return useCallback(
    (e) => {
      const requestId = beginPending(e);
      if (requestId !== null) post(requestId);
    },
    [post],
  );
}
