/**
 * The ship preview's Refresh, in the Ship stage header (`arch:SHIP-PREVIEW`). The preview's facts are the "will" rows
 * of the Commit, Push and Pull request processes; only the re-read control and the as-of time stay in the header, and
 * they render ONLY while the header's ship slot waits for Confirm / Retry (UI-R40 reading order: the header says how
 * fresh the prediction is, the ledger states the prediction).
 *
 * Refresh asks the host to re-read every worktree: it shows the click landed and cannot repeat, and settles on the
 * next settling push (the host sends one after the read, changed or not).
 */
import { memo, useCallback, type MouseEvent } from 'react';
import type { ShipPreview as Preview } from '../../../workflow/shipPreview.js';
import { useDashboardSend, useOps, usePendingOps } from './DashboardAppContext.js';
import { beginPending } from './usePendingAction.js';

function when(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export const ShipPreviewRefresh = memo(function ShipPreviewRefresh({ preview }: { readonly preview: Preview | null }) {
  const send = useDashboardSend();
  const ops = usePendingOps();
  const refreshing = useOps().running.has('previewRefresh');
  const onRefresh = useCallback(
    (e: MouseEvent<HTMLButtonElement>) => {
      if (ops.isRunning('previewRefresh')) return;
      const requestId = beginPending(e);
      if (requestId === null) return;
      ops.beginAction('previewRefresh', requestId);
      send.refreshShipPreview();
    },
    [ops, send],
  );
  return (
    <span className="ship-preview-refresh">
      {/* While the first read is in flight the header says so; the rows land with the next push. */}
      <span className="ship-preview-meta">{preview ? `as of ${when(preview.computedAt)}` : 'reading…'}</span>
      <button
        type="button"
        className="k-btn k-btn--ghost k-btn--sm"
        data-act="refresh-ship-preview"
        aria-busy={refreshing ? 'true' : 'false'}
        disabled={refreshing}
        title="Re-read the worktrees now"
        onClick={onRefresh}
      >
        Refresh
      </button>
    </span>
  );
});
