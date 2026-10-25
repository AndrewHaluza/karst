/**
 * "Deliver to PR": the count line and its action, Ship only, hidden while nothing is undelivered. The host syncs the
 * sandbox and pushes, reports through notifications, then sends a state push; the request carries no id on the wire,
 * so it is held in `pendingOps.ts` and settles on that push (a second click cannot start a second delivery).
 */
import { useCallback, type MouseEvent } from 'react';
import { useDashboardSend, useOps, usePendingOps } from './DashboardAppContext.js';
import { beginPending } from './usePendingAction.js';

export function DeliverRow({ notOnPr, inSandbox }: { readonly notOnPr: number; readonly inSandbox: number }) {
  const send = useDashboardSend();
  const ops = usePendingOps();
  const busy = useOps().running.has('deliver');
  const onClick = useCallback(
    (e: MouseEvent<HTMLButtonElement>) => {
      if (ops.isRunning('deliver')) return;
      const requestId = beginPending(e);
      if (requestId === null) return;
      ops.beginAction('deliver', requestId);
      send.deliverToPr();
    },
    [ops, send],
  );
  return (
    <div className="inside-deliver" role="status">
      <span>{`${notOnPr} commit${notOnPr === 1 ? '' : 's'} not on the PR${inSandbox > 0 ? ` (${inSandbox} still in the sandbox)` : ''}`}</span>
      <button
        type="button"
        className="k-btn k-btn--secondary k-btn--sm"
        data-act="deliver-to-pr"
        aria-busy={busy ? 'true' : undefined}
        disabled={busy}
        title="Sync the sandbox, then push the branch onto the open pull request"
        onClick={onClick}
      >
        Deliver to PR
      </button>
    </div>
  );
}
