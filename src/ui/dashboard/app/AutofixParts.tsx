/**
 * Auto-fix on the ship panel (T1070; reverses T1004's "no new row": the layout reference is docs/ui/prototypes/inside-cleanup.html).
 *
 * Small parts fed by host-built views (`model/inside/autofix.ts`): the one-chip override in the ship header, the
 * "Last round" button in the running step's action cell, the "Stop now" confirm under the Auto-fix row, and the body of
 * the blocked banner for an auto-fix park. The row itself is a generic process row. No part keeps state the host owns:
 * a click posts one message and the next snapshot settles it (@ui:PENDING-STATE).
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent, type MouseEvent } from 'react';
import type { AutofixBannerAction, AutofixBannerView } from '../../../model/inside/autofix.js';
import type { AutopilotSlice } from '../stateAutofix.js';
import { useDashboardSend } from './DashboardAppContext.js';
import { Icon } from './Icon.js';
import { insideActionSentence } from './insideText.js';
import { usePendingAction } from './usePendingAction.js';
import './Autofix.css';

type Override = AutopilotSlice['override'];

const onOff = (on: boolean): string => (on ? 'on' : 'off');

/** The chip text: the effective mode, plus "· default" while the project default decides. */
export const chipText = (a: AutopilotSlice): string => `Auto-fix ${onOff(a.effective)}${a.override === 'inherit' ? ' · default' : ''}`;

interface Choice {
  readonly mode: Override;
  readonly label: string;
  readonly hint?: string;
}

const choicesOf = (a: AutopilotSlice): readonly Choice[] => [
  { mode: 'inherit', label: 'Use project default', hint: `Settings › Autopilot: ${onOff(a.projectDefault)}` },
  { mode: 'on', label: 'On for this ticket' },
  { mode: 'off', label: 'Off for this ticket' },
];

function ChoiceItem({ choice, active, onDone }: { readonly choice: Choice; readonly active: boolean; readonly onDone: () => void }) {
  const send = useDashboardSend();
  // The pending marker settles with the next snapshot, which also moves the check (@ui:PENDING-STATE).
  const post = usePendingAction(useCallback((requestId: string) => send.autopilotOverride(choice.mode, requestId), [send, choice.mode]));
  const onClick = (e: MouseEvent<HTMLButtonElement>): void => {
    // A new choice keeps the menu open: its item shows the pending marker until the next snapshot moves the check and closes the menu.
    if (active) onDone();
    else post(e);
  };
  return (
    <button type="button" className="menuButton autofix-choice" role="menuitemradio" aria-checked={active} data-act="autopilot-override" data-mode={choice.mode} onClick={onClick}>
      <span className="autofix-check">{active ? <Icon name="check" size={16} /> : null}</span>
      <span className="autofix-choice-text">
        <span>{choice.label}</span>
        {choice.hint ? <span className="autofix-hint">{choice.hint}</span> : null}
      </span>
    </button>
  );
}

const menuItems = (menu: HTMLElement | null): HTMLElement[] =>
  menu ? Array.from(menu.querySelectorAll<HTMLElement>('[role="menuitemradio"]')) : [];

/** "Auto-fix on · default ▾": one borderless chip (the runtime strip's `.rs-dd` pattern) that opens the override menu. */
export function AutofixOverride({ autopilot }: { readonly autopilot: AutopilotSlice }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLSpanElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return undefined;
    const items = menuItems(menu.current);
    (items.find((i) => i.getAttribute('aria-checked') === 'true') ?? items[0])?.focus();
    const onClick = (e: Event): void => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('click', onClick);
    return () => document.removeEventListener('click', onClick);
  }, [open]);
  // The snapshot that carries the new override settles the pending item and closes the menu.
  useEffect(() => {
    // The menu item that held the focus goes away with the menu: the chip takes the focus back.
    if (wrap.current?.contains(document.activeElement) && document.activeElement !== trigger.current) trigger.current?.focus();
    setOpen(false);
  }, [autopilot.override]);
  const close = useCallback(() => {
    setOpen(false);
    trigger.current?.focus();
  }, []);
  const onKey = (e: KeyboardEvent<HTMLElement>): void => {
    // A closed chip leaves every key to the page (arrows, Home and End scroll or move a caret).
    if (!open) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
      return;
    }
    const items = menuItems(menu.current);
    const at = items.indexOf(document.activeElement as HTMLElement);
    const next = e.key === 'ArrowDown' ? (at + 1) % items.length : e.key === 'ArrowUp' ? (at <= 0 ? items.length - 1 : at - 1) : e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : -1;
    if (next < 0) return;
    e.preventDefault();
    items[next]?.focus();
  };
  return (
    <span className="autofix-chipwrap" ref={wrap} onKeyDown={onKey}>
      <button type="button" className="autofix-chip" ref={trigger} data-act="autopilot-menu" aria-haspopup="menu" aria-expanded={open} title="Choose how auto-fix runs for this ticket" onClick={() => setOpen((o) => !o)}>
        {autopilot.override !== 'inherit' ? <span className="autofix-dot" aria-hidden="true" /> : null}
        <span>{chipText(autopilot)}</span>
        <Icon name="chevron-down" size={16} />
      </button>
      {open ? (
        <div className="autofix-menu" role="menu" aria-label="Auto-fix" ref={menu}>
          {choicesOf(autopilot).map((c) => (
            <ChoiceItem key={c.mode} choice={c} active={autopilot.override === c.mode} onDone={close} />
          ))}
        </div>
      ) : null}
    </span>
  );
}

/** Whether the inline "Stop now" confirm is open. The stage menu opens it, the Auto-fix row shows it: they share this flag. */
const confirmListeners = new Set<() => void>();
let confirmOpen = false;
export function setStopConfirm(open: boolean): void {
  if (confirmOpen === open) return;
  confirmOpen = open;
  confirmListeners.forEach((l) => l());
}
const subscribeConfirm = (l: () => void): (() => void) => {
  confirmListeners.add(l);
  return () => confirmListeners.delete(l);
};
const useStopConfirm = (): boolean => useSyncExternalStore(subscribeConfirm, () => confirmOpen, () => false);

/** "Last round", in the action cell of the running step. The click may sit inside a <summary>: it must not toggle the disclosure. */
export function LastRoundButton({ requested }: { readonly requested: boolean }) {
  const send = useDashboardSend();
  const post = usePendingAction(useCallback((requestId: string) => send.autopilotStop('after-round', requestId), [send]));
  const label = requested ? 'Stopping' : 'Last round';
  const title = `${label} — ${requested ? 'auto-fix stops after this round' : 'stop auto-fix after this round'}`;
  return (
    <button type="button" className="k-btn k-btn--secondary k-btn--sm" data-act="autopilot-stop-after" disabled={requested} title={title} aria-label={title} onClick={(e) => { e.preventDefault(); post(e); }}>
      <Icon name="player-pause" size={16} />
      <span>{label}</span>
    </button>
  );
}

/** The inline alertdialog under the Auto-fix row: it ends the agent session, so it asks first. */
export function StopNowConfirm() {
  const send = useDashboardSend();
  const open = useStopConfirm();
  const confirmRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const rowRef = useRef<HTMLDetailsElement | null>(null);
  // Closing the dialog removes the focused button: hand the focus to the row's summary, never to the page.
  const dismiss = useCallback(() => {
    rowRef.current?.querySelector('summary')?.focus();
    setStopConfirm(false);
  }, []);
  // The flag is module-wide: leaving the row (another ticket or stage) must not leave the confirm armed.
  useEffect(() => () => setStopConfirm(false), []);
  useEffect(() => {
    // A row the user collapsed keeps this dialog hidden. The disclosure memory does not re-render, so open the native <details> itself.
    const row = dialogRef.current?.closest('details') ?? null;
    if (open) rowRef.current = row;
    if (open && row && !row.open) row.open = true;
    if (open) confirmRef.current?.focus();
  }, [open]);
  const now = usePendingAction(useCallback((requestId: string) => { dismiss(); send.autopilotStop('now', requestId); }, [send, dismiss]));
  if (!open) return null;
  return (
    <div className="autofix-actions" ref={dialogRef} role="alertdialog" aria-label="Stop auto-fix now" onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); dismiss(); } }}>
      <span className="autofix-confirm">This ends the agent session. Karst syncs first.</span>
      <button type="button" className="k-btn k-btn--danger k-btn--sm" ref={confirmRef} data-act="autopilot-stop-now" onClick={(e) => { e.preventDefault(); now(e); }}>Stop now</button>
      <button type="button" className="k-btn k-btn--ghost k-btn--sm" data-act="autopilot-stop-cancel" onClick={(e) => { e.preventDefault(); dismiss(); }}>Cancel</button>
    </div>
  );
}

/** The banner button's title = aria-label: the full sentence, starting with the visible label. */
const bannerSentence = (a: AutofixBannerAction): string => insideActionSentence(a.label, a.title);

function BannerButton({ action, primary, ticketRepoFallback }: { readonly action: AutofixBannerAction; readonly primary: boolean; readonly ticketRepoFallback?: string }) {
  const send = useDashboardSend();
  const repo = action.repo ?? ticketRepoFallback ?? '';
  const post = useCallback((requestId: string) => {
    if (action.act === 'autopilot-approve-one' && action.kind) send.autopilotApproveOne(repo, action.kind, requestId);
    else if (action.act === 'autopilot-retry') send.autopilotRetry(requestId);
    else if (action.act === 'sandbox-diff') send.sandboxDiff(requestId);
    else if (action.act === 'send-ci-failure') send.sendCiFailure(requestId);
    else if (action.act === 'resolve-conflicts') send.resolveConflicts(repo, requestId);
  }, [send, action, repo]);
  const onClick = usePendingAction(post);
  // An approval names a PR. Without one the host cannot tell which budget to extend, so the control stays off.
  const needsRepo = action.act === 'autopilot-approve-one' && repo === '';
  return (
    <button type="button" className={`k-btn ${primary ? 'k-btn--primary' : 'k-btn--secondary'} k-btn--sm`} data-act={action.act} disabled={needsRepo} title={bannerSentence(action)} aria-label={bannerSentence(action)} onClick={onClick}>
      {action.icon ? <Icon name={action.icon} size={16} /> : null}
      <span>{action.label}</span>
    </button>
  );
}

/** The blocked banner's body for an auto-fix park: title (the check is the log link), cause, ONE primary, one secondary, history. */
export function AutofixBannerBody({ banner }: { readonly banner: AutofixBannerView }) {
  return (
    <>
      <span className="fdot" aria-hidden="true" />
      <span className="ftext">
        <span className="ftitle">
          {banner.titleHref ? <a href={banner.titleHref} className="autofix-check-link">{banner.title}</a> : banner.title}
          {banner.titleSuffix ? ` ${banner.titleSuffix}` : ''}
        </span>
        <span className="freason">{` · ${banner.cause}`}</span>
      </span>
      <div className="facts">
        {banner.primary ? <BannerButton action={banner.primary} primary /> : null}
        {banner.secondary ? <BannerButton action={banner.secondary} primary={false} /> : null}
      </div>
      {banner.history.length > 0 ? (
        <details className="autofix-history">
          <summary>Attempt history</summary>
          <ul>{banner.history.map((h, i) => <li key={`${i}:${h}`}>{h}</li>)}</ul>
        </details>
      ) : null}
    </>
  );
}
