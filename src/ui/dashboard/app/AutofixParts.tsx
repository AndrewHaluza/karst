/**
 * Auto-fix on the ship panel (T1004; layout: docs/ui/prototypes/autopilot-inapp-v2.html).
 *
 * Four small parts, all fed by host-built views (`model/inside/autofix.ts`): the tri-state override in the
 * ship header, the step line and stop actions on the Merge row, the short action log under the panel, and
 * the body of the blocked banner for an auto-fix park. No part keeps state the host owns: a click posts one
 * message and the next snapshot settles it (@ui:PENDING-STATE). Autopilot never merges (@arch:GH-04), so
 * no part here offers a merge.
 */
import { useCallback, useState, type MouseEvent } from 'react';
import type { AutofixBannerAction, AutofixBannerView, AutofixRowView } from '../../../model/inside/autofix.js';
import type { AutopilotSlice } from '../stateAutofix.js';
import { useDashboardSend } from './DashboardAppContext.js';
import { usePendingAction } from './usePendingAction.js';
import './Autofix.css';

type Override = AutopilotSlice['override'];

const onOff = (on: boolean): string => (on ? 'on' : 'off');

function OverrideSegment({ mode, label, active }: { readonly mode: Override; readonly label: string; readonly active: boolean }) {
  const send = useDashboardSend();
  // The pending marker settles with the next snapshot, which also moves `aria-pressed` (@ui:PENDING-STATE).
  const post = usePendingAction(useCallback((requestId: string) => send.autopilotOverride(mode, requestId), [send, mode]));
  const onClick = (e: MouseEvent<HTMLButtonElement>): void => {
    if (active) return;
    post(e);
  };
  return (
    <button type="button" className="autofix-seg" data-act="autopilot-override" data-mode={mode} aria-pressed={active} onClick={onClick}>
      {label}
    </button>
  );
}

/** "Auto-fix: Project default (on|off) / On / Off": one group, `aria-pressed` on the active choice. */
export function AutofixOverride({ autopilot }: { readonly autopilot: AutopilotSlice }) {
  const choices: ReadonlyArray<readonly [Override, string]> = [
    ['inherit', `Project default (${onOff(autopilot.projectDefault)})`],
    ['on', 'On'],
    ['off', 'Off'],
  ];
  return (
    <span className="autofix-override" role="group" aria-label="Auto-fix">
      <span className="autofix-override-label" aria-hidden="true">Auto-fix:</span>
      {choices.map(([mode, label]) => (
        <OverrideSegment key={mode} mode={mode} label={label} active={autopilot.override === mode} />
      ))}
    </span>
  );
}

/** The step line of a running round: the active step is marked, the rest read in order. */
function StepLine({ row }: { readonly row: AutofixRowView }) {
  return (
    <ol className="autofix-steps" aria-label="Auto-fix steps">
      {row.steps.map((step, i) => (
        <li key={step} aria-current={i === row.activeStep ? 'step' : undefined} className={i === row.activeStep ? 'is-active' : undefined}>
          {step}
        </li>
      ))}
    </ol>
  );
}

/** "Stop after this round" and "Stop now…" (an in-page confirm: it ends the session). */
function StopActions({ requested }: { readonly requested: boolean }) {
  const send = useDashboardSend();
  const [confirming, setConfirming] = useState(false);
  // The click sits inside a <summary> on some rows: it must not also toggle the disclosure.
  const after = usePendingAction(useCallback((requestId: string) => send.autopilotStop('after-round', requestId), [send]));
  const now = usePendingAction(useCallback((requestId: string) => { setConfirming(false); send.autopilotStop('now', requestId); }, [send]));
  const guard = (fn: (e: MouseEvent<HTMLElement>) => void) => (e: MouseEvent<HTMLElement>) => { e.preventDefault(); fn(e); };
  if (confirming) {
    return (
      <span className="autofix-actions" role="alertdialog" aria-label="Stop auto-fix now">
        <span className="autofix-confirm">This ends the agent session. Karst syncs first.</span>
        <button type="button" className="k-btn k-btn--primary k-btn--sm" data-act="autopilot-stop-now" onClick={guard(now)}>Stop now</button>
        <button type="button" className="k-btn k-btn--ghost k-btn--sm" data-act="autopilot-stop-cancel" onClick={guard(() => setConfirming(false))}>Cancel</button>
      </span>
    );
  }
  return (
    <span className="autofix-actions">
      <button type="button" className="k-btn k-btn--secondary k-btn--sm" data-act="autopilot-stop-after" disabled={requested} onClick={guard(after)}>
        {requested ? 'Stopping after this round' : 'Stop after this round'}
      </button>
      <button type="button" className="k-btn k-btn--ghost k-btn--sm" data-act="autopilot-stop-confirm" onClick={guard(() => setConfirming(true))}>Stop now…</button>
    </span>
  );
}

/** The step line and the stop actions, under the Merge row's message. Only a running round has either. */
export function AutofixRowExtras({ row }: { readonly row: AutofixRowView }) {
  if (row.state !== 'running') return null;
  return (
    <span className="autofix-extras">
      <StepLine row={row} />
      <StopActions requested={row.stopAfterRequested} />
    </span>
  );
}

/** The short auto-action log (`data-region="autofix-log"`) and the never-merges line, under the ship panel. */
export function AutofixFooter({ autopilot }: { readonly autopilot: AutopilotSlice }) {
  return (
    <div className="autofix-foot">
      {autopilot.log.length > 0 ? (
        <ul className="autofix-log" data-region="autofix-log" aria-label="Recent auto-fix actions">
          {autopilot.log.map((line, i) => <li key={`${i}:${line}`}>{line}</li>)}
        </ul>
      ) : null}
      <p className="autofix-note">Autopilot never merges. Merge stays your click.</p>
    </div>
  );
}

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
    <button type="button" className={`k-btn ${primary ? 'k-btn--primary' : 'k-btn--secondary'} k-btn--sm`} data-act={action.act} disabled={needsRepo} onClick={onClick}>
      {action.label}
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
