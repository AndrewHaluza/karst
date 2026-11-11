/**
 * The stage header's actions: the host-picked main action as a visible secondary button, and a ghost 'Actions' button
 * that opens the rest, grouped, each item with a one-line description. It renders only when the host's availability
 * verdict says the stage offers at least one action. Local view state: open or closed, closed again by a pick of any stage
 * (the parent remounts it per selection epoch), by Escape, by a click anywhere else and by choosing an item.
 *
 * Each item posts a host-confirmed action (a modal, then a state push that always follows) with no request id on
 * the wire, so the request is held in `pendingOps.ts` until the next settling push. That store is what keeps a
 * second click from opening a second dialog even though the menu closes (and its item unmounts) on the first, and
 * what the pull request panel's Send CI failure shares. The menu tells the overlay stack whether it is open, whose Escape
 * chain is ordered (`overlayStack.ts`): it yields to the menu at the menu's place.
 */
import { useCallback, useEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import type { GateStage } from '../../../store/ticketGates.js';
import { useDashboardSend, useOverlays, usePendingOps } from './DashboardAppContext.js';
import { setStopConfirm } from './AutofixParts.js';
import { Icon } from './Icon.js';
import type { MainAction, MenuFlags } from './insideSlices.js';
import type { ActionName } from './pendingOps.js';
import { insideActionSentence } from './insideText.js';
import { beginPending } from './usePendingAction.js';

interface ItemProps {
  /** Spelled as a literal at each call site: the parity guard reads the acts the app emits from the source. */
  readonly 'data-act': string;
  readonly 'data-stage'?: string;
  readonly description: string;
  readonly icon: string;
  readonly label: string;
  readonly danger?: true;
  readonly onClick: (e: MouseEvent<HTMLButtonElement>) => void;
}

/** One menu item: icon, label, and a one-line description. The title = the sentence, which starts with the label. */
function Item({ icon, label, description, danger, onClick, ...data }: ItemProps) {
  const sentence = insideActionSentence(label, description);
  return (
    <button type="button" className={`menuButton${danger ? ' danger' : ''}`} role="menuitem" {...data} title={sentence} onClick={onClick}>
      <Icon name={icon} size={16} />
      <span className="menuText">
        <span className="menuLabel">{label}</span>
        <span className="menuDesc">{description}</span>
      </span>
    </button>
  );
}

function Group({ title, children }: { readonly title: string; readonly children: ReactNode }) {
  return (
    <div className="menuGroup" role="group" aria-label={title}>
      <div className="menuGroupTitle" aria-hidden="true">{title}</div>
      {children}
    </div>
  );
}

const gateWord = (stage: string): string => (stage === 'uat' ? 'UAT' : 'Review');

/** The visible main button's glyph, label and sentence per action. */
const MAIN: Readonly<Record<MainAction, { readonly act: string; readonly icon: string; readonly label: string; readonly description: string; readonly name: ActionName }>> = {
  retry: { act: 'rerun-gate', icon: 'refresh', label: 'Retry', description: 're-run this stage from scratch', name: 'sendBack' },
  ci: { act: 'send-ci-failure', icon: 'send', label: 'Send CI failure', description: 'send the failing CI log to the agent — UAT and Review will run again', name: 'ci' },
  prFeedback: { act: 'address-pr-feedback', icon: 'pencil', label: 'Address feedback', description: "send the review team's pull request feedback to the agent — UAT and Review will run again", name: 'prFeedback' },
  rebase: { act: 'rebase-on-base', icon: 'arrows-down-up', label: 'Rebase', description: 'rebase onto the base branch, regenerate files, push with a lease', name: 'rebase' },
};

export function StageMenu({ stageKey, menu, main }: { readonly stageKey: string; readonly menu: MenuFlags; readonly main: MainAction | null }) {
  const send = useDashboardSend();
  const ops = usePendingOps();
  const overlays = useOverlays();
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return undefined;
    overlays.setStageMenuOpen(true);
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
      overlays.setStageMenuOpen(false);
    };
  }, [open, overlays]);

  /** One action: refused while its operation is in flight, otherwise pending on the control, held in the shared store, menu closed, then posted. */
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
  // Retry and Send back share one request: both put a confirmation modal in front of the user.
  const post: Readonly<Record<MainAction, () => void>> = {
    retry: () => send.rerunGate(menu.retry as GateStage),
    ci: () => send.sendCiFailure(),
    prFeedback: () => send.addressPrFeedback(),
    rebase: () => send.rebaseOnBase(),
  };
  const mainSpec = main ? MAIN[main] : null;
  const mainSentence = mainSpec ? insideActionSentence(mainSpec.label, mainSpec.description) : '';
  const show = (a: MainAction): boolean => main !== a;
  const runAgain = (menu.reset !== null) || (menu.retry !== null && show('retry'));
  const toAgent = (menu.prFeedback && show('prFeedback')) || (menu.ci && show('ci')) || menu.sendBack;
  const branch = menu.rebase && show('rebase');
  const rest = runAgain || toAgent || branch || menu.deliverFailures || menu.autofixStop;

  return (
    <span className="stageMenuWrap" ref={wrap}>
      {mainSpec && main ? (
        <button type="button" className="k-btn k-btn--secondary k-btn--sm stageMain" data-act={mainSpec.act} data-stage={main === 'retry' ? (menu.retry ?? undefined) : undefined} title={mainSentence} aria-label={mainSentence} onClick={start(mainSpec.name, post[main])}>
          <Icon name={mainSpec.icon} size={16} />
          <span>{mainSpec.label}</span>
        </button>
      ) : null}
      {rest ? (
        <button type="button" className="k-btn k-btn--ghost k-btn--sm stageMenuBtn" data-stage-menu={stageKey} aria-label="Actions — more actions for this stage" title="Actions — more actions for this stage" data-tip="Actions — more actions for this stage" aria-haspopup="menu" aria-expanded={open ? 'true' : 'false'} onClick={() => setOpen((o) => !o)}>
          <Icon name="dots" size={16} />
          <span className="stageMenuLabel">Actions</span>
        </button>
      ) : null}
      {open && rest ? (
        <div className="stageMenu" role="menu" aria-label="Stage actions">
          {runAgain ? (
            <Group title="Run again">
              {menu.retry && show('retry') ? (
                <Item data-act="rerun-gate" data-stage={menu.retry} description="Re-run this stage from scratch" icon="refresh" label={`Retry ${gateWord(menu.retry)}`} onClick={start('sendBack', () => send.rerunGate(menu.retry as GateStage))} />
              ) : null}
              {menu.reset ? (
                <Item data-act="reset-stage" data-stage={menu.reset} description="Clear the failed stage and start a fresh recovery episode" icon="arrow-back-up" label={`Reset ${gateWord(menu.reset)}`} onClick={start('resetStage', () => send.resetStage())} />
              ) : null}
            </Group>
          ) : null}
          {toAgent ? (
            <Group title="Send to the agent">
              {menu.prFeedback && show('prFeedback') ? (
                <Item data-act="address-pr-feedback" description="Send the review team's pull request feedback — UAT and Review will run again" icon="pencil" label="Address feedback" onClick={start('prFeedback', () => send.addressPrFeedback())} />
              ) : null}
              {menu.ci && show('ci') ? (
                <Item data-act="send-ci-failure" description="Send the failing CI log — UAT and Review will run again" icon="send" label="Send CI failure" onClick={start('ci', () => send.sendCiFailure())} />
              ) : null}
              {menu.sendBack ? (
                <Item data-act="send-back-to-implement" description="Move this ticket back to Implement — UAT and Review will run again" icon="arrow-left" label="Send back to Implement" onClick={start('sendBack', () => send.sendBackToImplement())} />
              ) : null}
            </Group>
          ) : null}
          {branch ? (
            <Group title="Branch">
              <Item data-act="rebase-on-base" description="Rebase onto the base branch, regenerate files, push with a lease" icon="arrows-down-up" label="Rebase" onClick={start('rebase', () => send.rebaseOnBase())} />
            </Group>
          ) : null}
          {menu.deliverFailures ? (
            <Group title="Delivery">
              {/* Local and instant: it drops the kept gate failures, so it needs no confirmation and no pending state. */}
              <Item data-act="dismiss-deliver-failures" description="Drop every gate failure kept from the auto-deliver" icon="x" label="Dismiss delivery failures" onClick={() => { setOpen(false); send.dismissDeliverFailures(); }} />
            </Group>
          ) : null}
          {menu.autofixStop ? (
            <Group title="Auto-fix">
              {/* Opens the inline confirm under the Auto-fix row (it ends the agent session); nothing is posted from here. */}
              <Item data-act="autopilot-stop-confirm" danger description="End the agent session; Karst syncs first" icon="player-stop" label="Stop auto-fix now…" onClick={() => { setOpen(false); setStopConfirm(true); }} />
            </Group>
          ) : null}
        </div>
      ) : null}
    </span>
  );
}
