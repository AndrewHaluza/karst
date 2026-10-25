/**
 * The header's ship and wait surfaces, in their DOM order: the post-ship toast, Confirm ship, and the
 * ship / sub-task / paused wait chips. Same DOM as the vanilla `renderShip`, `renderSubtaskBlock` and
 * `renderPause` they replaced.
 *
 * The host's `state.ship` is the placement truth. The in-flight ship request is page state (the stage rail's Ship
 * button shares it), so it arrives through the `karst:shipState` seam and the click announces `karst:shipBegin`.
 */
import { memo, useEffect, useState } from 'react';
import { useDashboardSend } from './DashboardAppContext.js';
import { announceShipBegin, onShipState, type ShipState } from './headerSeam.js';
import { selectControls } from './headerSlices.js';
import { beginPending, usePendingAction } from './usePendingAction.js';
import { useSlice } from './useSlice.js';

/** How long the "Shipped" confirmation shows. */
const TOAST_MS = 1400;
const SHIPPED_TEXT = 'Shipped ✓';

const IDLE: ShipState = { inFlight: false, shipped: false };

function useShipState(): ShipState {
  const [ship, setShip] = useState<ShipState>(IDLE);
  useEffect(() => onShipState(setShip), []);
  return ship;
}

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

function Mark() {
  return (
    <span className="attentionMark" aria-hidden="true">
      ❚❚
    </span>
  );
}

export const ShipControls = memo(function ShipControls() {
  const controls = useSlice(selectControls);
  const send = useDashboardSend();
  const ship = useShipState();
  const slot = controls?.ship ?? { kind: 'none' as const };
  const onResume = usePendingAction((requestId) => send.unpauseExecution(requestId));

  const waiting = slot.kind === 'waiting-merge';
  const offered = (slot.kind === 'confirm' || slot.kind === 'retry') && !ship.inFlight;
  const shipping = !waiting && !offered && (slot.kind === 'shipping' || ship.inFlight);
  const subtaskWait = controls?.subtaskWait ?? null;

  const onConfirm = (e: React.MouseEvent<HTMLButtonElement>): void => {
    if (ship.inFlight) return;
    const requestId = beginPending(e);
    if (requestId === null) return;
    announceShipBegin(requestId);
    send.shipTicket();
  };

  return (
    <>
      <Toast shipped={ship.shipped} />
      <button
        id="confirmShip"
        type="button"
        className="k-btn k-btn--primary k-btn--sm shipAction"
        data-act="ship-ticket"
        title="Ship this ticket — commit, push, and open pull requests"
        aria-busy={shipping ? 'true' : 'false'}
        hidden={!offered && !shipping}
        disabled={shipping}
        onClick={onConfirm}
      >
        {shipping ? 'Shipping…' : slot.kind === 'retry' ? 'Retry ship' : 'Confirm ship'}
      </button>
      <span
        id="shipWait"
        className={waiting ? 'shipWait' : 'shipWait hidden'}
        role="status"
        title={
          waiting
            ? slot.repos > 0
              ? `Waiting for ${slot.repos} ${slot.repos === 1 ? 'repo' : 'repos'} to be merged`
              : 'Waiting for the pull requests to be merged'
            : undefined
        }
      >
        <Mark />
        <span>Waiting to merge</span>
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
