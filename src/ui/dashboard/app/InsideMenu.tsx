/**
 * The stage header's ⋯ menu: the ONE recovery surface. It renders only when the host's availability verdict says
 * the stage offers at least one recovery action. Local view state: open or closed, closed again by a pick of any stage
 * (the parent remounts it per selection epoch), by Escape, by a click anywhere else and by choosing an item.
 *
 * Each item posts a host-confirmed action (a modal, then a state push that always follows) with no request id on
 * the wire, so the request is held in `pendingOps.ts` until the next settling push. That store is what keeps a
 * second click from opening a second dialog even though the menu closes (and its item unmounts) on the first, and
 * what the pull request panel's Send CI failure shares. The menu announces its open state to the page, whose Escape
 * chain is ordered (`insideSeam.ts`).
 */
import { useCallback, useEffect, useRef, useState, type MouseEvent } from 'react';
import type { GateStage } from '../../../store/ticketGates.js';
import { useDashboardSend, usePendingOps } from './DashboardAppContext.js';
import { Icon } from './Icon.js';
import { announceStageMenuOpen } from './insideSeam.js';
import type { MenuFlags } from './insideSlices.js';
import type { ActionName } from './pendingOps.js';
import { beginPending } from './usePendingAction.js';

interface ItemProps {
  /** Spelled as a literal at each call site: the parity guard reads the acts the app emits from the source. */
  readonly 'data-act': string;
  readonly 'data-stage'?: string;
  readonly title: string;
  readonly icon: string;
  readonly label: string;
  readonly onClick: (e: MouseEvent<HTMLButtonElement>) => void;
}

function Item({ icon, label, onClick, title, ...data }: ItemProps) {
  return (
    <button type="button" className="menuButton" role="menuitem" {...data} title={title} onClick={onClick}>
      <Icon name={icon} size={16} />
      <span>{label}</span>
    </button>
  );
}

export function StageMenu({ stageKey, menu }: { readonly stageKey: string; readonly menu: MenuFlags }) {
  const send = useDashboardSend();
  const ops = usePendingOps();
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return undefined;
    announceStageMenuOpen(true);
    const onKey = (e: KeyboardEvent): void => {
      // Another surface (the ticket-data drawer, an overlay) that already took this Escape keeps it.
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      e.preventDefault();
      setOpen(false);
    };
    const onClick = (e: Event): void => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('click', onClick);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('click', onClick);
      announceStageMenuOpen(false);
    };
  }, [open]);

  /** One item: refused while its operation is in flight, otherwise pending on the control, held in the shared store, menu closed, then posted. */
  const start = useCallback(
    (name: ActionName, post: () => void) => (e: MouseEvent<HTMLButtonElement>) => {
      if (ops.isRunning(name)) return;
      const requestId = beginPending(e);
      if (requestId === null) return;
      ops.beginAction(name, requestId);
      setOpen(false);
      post();
    },
    [ops],
  );

  return (
    <span className="stageMenuWrap" ref={wrap}>
      <button type="button" className="k-iconbtn stageMenuBtn" data-stage-menu={stageKey} aria-label="Stage actions" aria-haspopup="menu" aria-expanded={open ? 'true' : 'false'} onClick={() => setOpen((o) => !o)}>
        <Icon name="dots" size={16} />
      </button>
      {open ? (
        <div className="stageMenu" role="menu" aria-label="Stage actions">
          {menu.retry ? (
            // Retry and Send back share one request: both put a confirmation modal in front of the user.
            <Item data-act="rerun-gate" data-stage={menu.retry} title="Re-run this stage from scratch" icon="refresh" label={`Retry ${menu.retry === 'uat' ? 'UAT' : 'Review'}`} onClick={start('sendBack', () => send.rerunGate(menu.retry as GateStage))} />
          ) : null}
          {menu.prFeedback ? (
            <Item data-act="address-pr-feedback" title="Address the review team's pull request feedback — UAT and Review will run again" icon="pencil" label="Address PR feedback" onClick={start('prFeedback', () => send.addressPrFeedback())} />
          ) : null}
          {menu.ci ? (
            <Item data-act="send-ci-failure" title="Send the failing CI log to the agent — UAT and Review will run again" icon="history" label="Send CI failure to agent" onClick={start('ci', () => send.sendCiFailure())} />
          ) : null}
          {menu.rebase ? (
            <Item data-act="rebase-on-base" title="Rebase onto the base branch, regenerate files, push with a lease" icon="refresh" label="Rebase on base" onClick={start('rebase', () => send.rebaseOnBase())} />
          ) : null}
          {menu.sendBack ? (
            <Item data-act="send-back-to-implement" title="Move this ticket back to Implement — UAT and Review will run again" icon="history" label="Send back to Implement" onClick={start('sendBack', () => send.sendBackToImplement())} />
          ) : null}
        </div>
      ) : null}
    </span>
  );
}
