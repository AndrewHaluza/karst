/**
 * The header's ship and wait surfaces, in their DOM order: the post-ship toast and the
 * ship / sub-task / paused wait chips. Shipping itself lives only on the stage rail's Ship button. Same DOM as the vanilla `renderShip`, `renderSubtaskBlock` and
 * `renderPause` they replaced.
 *
 * The host's `state.ship` is the placement truth. The post-ship flash comes from the same shared ops state
 * (`pendingOps.ts`) the rail's Ship button drives.
 *
 * During a merge conflict the chip only MIRRORS the block: "Merge blocked" in the attention tone, with no button.
 * The blocked banner owns the reason and Resolve (Q1, DB-3, UI-R40).
 */
import { memo, useEffect, useState } from 'react';
import { mergeBlockedDetail, type ShipSlot } from '../../../model/shipSlot.js';
import { useDashboardSend, useOps } from './DashboardAppContext.js';
import { selectControls } from './headerSlices.js';
import { Icon } from './Icon.js';
import { usePendingAction } from './usePendingAction.js';
import { useSlice } from './useSlice.js';

/** How long the "Shipped" confirmation shows. */
const TOAST_MS = 1400;
const SHIPPED_TEXT = 'Shipped ✓';

function Toast({ shipped }: { readonly shipped: boolean }) {
  const [toast, setToast] = useState({ text: '', show: false });
  useEffect(() => {
    if (!shipped) return undefined;
    setToast({ text: SHIPPED_TEXT, show: true });
    const timer = setTimeout(() => setToast((t) => ({ ...t, show: false })), TOAST_MS);
    return () => clearTimeout(timer);
  }, [shipped]);
  return (
    <span id="toast" className={toast.show ? 'toast show' : 'toast'} aria-live="polite">
      {toast.text}
    </span>
  );
}

/** The shared "waiting" mark: the same attention ring every wait chip carries (DB-21). */
function Mark() {
  return (
    <span className="attentionMark" aria-hidden="true">
      <Icon name="player-pause" size={12} />
    </span>
  );
}

const repoCount = (n: number): string => `${n} ${n === 1 ? 'repo' : 'repos'}`;

/** The chip's tooltip: the conflict count, or how many repos the calm wait is for. */
function waitTitle(slot: ShipSlot): string | undefined {
  if (slot.kind === 'merge-blocked') return mergeBlockedDetail(slot.repos.length);
  if (slot.kind !== 'waiting-merge') return undefined;
  return slot.repos > 0 ? `Waiting for ${repoCount(slot.repos)} to be merged` : 'Waiting for the pull requests to be merged';
}

export const ShipControls = memo(function ShipControls() {
  const controls = useSlice(selectControls);
  const send = useDashboardSend();
  const ship = useOps();
  const slot = controls?.ship ?? { kind: 'none' as const };
  const onResume = usePendingAction((requestId) => send.unpauseExecution(requestId));

  const conflict = slot.kind === 'merge-blocked';
  const waiting = slot.kind === 'waiting-merge' || conflict;
  const subtaskWait = controls?.subtaskWait ?? null;

  return (
    <>
      <Toast shipped={ship.shipped} />
      <span id="shipWait" className={waiting ? 'shipWait' : 'shipWait hidden'} role="status" data-tone={conflict ? 'attention' : undefined} title={waitTitle(slot)}>
        <Mark />
        <span>{conflict ? 'Merge blocked' : 'Waiting to merge'}</span>
      </span>
      <span
        id="subtaskWait"
        className={subtaskWait === null ? 'shipWait hidden' : 'shipWait'}
        role="status"
        title={subtaskWait === null ? undefined : 'This parent resumes when its sub-tasks are done.'}
      >
        <Mark />
        <span id="subtaskWaitText">{subtaskWait ? subtaskWait.charAt(0).toUpperCase() + subtaskWait.slice(1) : 'Waiting on sub-tasks'}</span>
      </span>
      <span id="pauseWait" className={controls?.paused ? 'shipWait' : 'shipWait hidden'} role="status">
        <Mark />
        <span>Execution paused</span>
        <button type="button" className="k-btn k-btn--secondary k-btn--sm" data-act="unpause-execution" onClick={onResume}>
          Resume
        </button>
      </span>
    </>
  );
});
