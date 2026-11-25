/**
 * The needs-you control inside the current rail segment, rendered from the host's `cta` verdict, never from
 * the action LABEL (which is prose). Four kinds ACT, posting the same message as the header's Confirm ship,
 * the PR panel's Merge, Retry ship and Open session (`resume-ticket`); the host's confirmation still guards
 * the irreversible merge. The rest NAVIGATE to the control that owns the action and post nothing.
 *
 * A merge conflict (`resolve-conflicts`, `resolve-panel`) draws NO control: the blocked banner owns the reason and
 * Resolve, and the segment keeps only its glyph and short label (Q1, DB-3, UI-R40). The host verdict keeps both
 * kinds, because the sidebar peek still acts on them.
 *
 * Ship and Merge share their in-flight state with the header and the PR panel (`pendingOps.ts`): one
 * operation, one dialog. They carry no request id on the wire (the host answers with a state push); the
 * shared state keeps the id the runtime settles.
 *
 * A control that may be runtime-pending keeps one className whatever it shows: the runtime's `is-pending`
 * class lives on that node.
 */
import { memo, useCallback, type MouseEvent } from 'react';
import { DRAIN_HOLD_REASON, selectDraining } from './drainSlices.js';
import { useSlice } from './useSlice.js';
import { useDashboardSend, usePendingOps } from './DashboardAppContext.js';
import type { RailSeg } from './railText.js';
import { beginPending, usePendingAction } from './usePendingAction.js';

type Needs = NonNullable<RailSeg['needs']>;

/**
 * Scrolls the control that owns the action into view and focuses it. Graph waits belong to the selected
 * Inside view; quota blocks (`usage-limit-pick`) belong to the blocked banner's pick control (falling back
 * to `#blocked` when absent); the merge kinds live on the PR panel, where each repo has its own control.
 */
export function gotoAction(kind: string): void {
  const byId = (id: string): HTMLElement | null => document.getElementById(id);
  const target =
    kind === 'graph-panel'
      ? byId('inside')
      : kind === 'usage-limit-pick'
        ? (byId('blocked')?.querySelector<HTMLElement>('[data-act="usage-limit-pick"]') ?? null)
        : ((byId('prs')?.getElementsByClassName('mgbtn')[0] as HTMLElement | undefined) ?? null);
  const scrollTo = target ?? (kind === 'graph-panel' ? byId('inside') : kind === 'usage-limit-pick' ? byId('blocked') : byId('prs'));
  if (!scrollTo) return;
  if (typeof scrollTo.scrollIntoView === 'function') scrollTo.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  if (target && typeof target.focus === 'function') target.focus();
}

const ShipGo = memo(function ShipGo({ label, busy }: { readonly label: string; readonly busy: boolean }) {
  const send = useDashboardSend();
  const ops = usePendingOps();
  const draining = useSlice(selectDraining);
  const onClick = useCallback(
    (e: MouseEvent<HTMLButtonElement>) => {
      if (busy || draining) return;
      const requestId = beginPending(e);
      if (requestId === null) return;
      ops.beginShip(requestId);
      send.shipTicket();
    },
    [busy, draining, ops, send],
  );
  return (
    <button
      type="button"
      className="go"
      data-act="ship-ticket"
      aria-busy={busy ? 'true' : undefined}
      disabled={busy || draining}
      title={draining ? `${label} — ${DRAIN_HOLD_REASON}` : undefined}
      onClick={onClick}
    >
      {label}
    </button>
  );
});

const MergeGo = memo(function MergeGo({ label, repo, busy }: { readonly label: string; readonly repo: string; readonly busy: boolean }) {
  const send = useDashboardSend();
  const ops = usePendingOps();
  const onClick = useCallback(
    (e: MouseEvent<HTMLButtonElement>) => {
      if (!repo || busy) return;
      const requestId = beginPending(e);
      if (requestId === null) return;
      ops.beginMerge(repo, requestId);
      send.mergePr(repo);
    },
    [busy, ops, repo, send],
  );
  return (
    <button type="button" className="go" data-act="merge-pr" data-repo={repo} aria-busy={busy ? 'true' : undefined} disabled={busy} onClick={onClick}>
      {label}
    </button>
  );
});

const RetryShipGo = memo(function RetryShipGo({ label }: { readonly label: string }) {
  const send = useDashboardSend();
  const onClick = usePendingAction(useCallback((requestId: string) => send.retryShip(requestId), [send]));
  return (
    <button type="button" className="go" data-act="retry-ship" onClick={onClick}>
      {label}
    </button>
  );
});

/**
 * Starts or focuses the ticket's agent session via `resume-ticket` (`karst.openSession`).
 * For a graph-owned ticket the host reveals the live node terminal or reports `launchBlocked`
 * and never starts a second agent; for an already-open session it only focuses it.
 */
const OpenSessionGo = memo(function OpenSessionGo({ label }: { readonly label: string }) {
  const send = useDashboardSend();
  const onClick = usePendingAction(useCallback((requestId: string) => send.resumeTicket(requestId), [send]));
  return (
    <button type="button" className="go" data-act="resume-ticket" onClick={onClick}>
      {label}
    </button>
  );
});

function GotoGo({ label, kind }: { readonly label: string; readonly kind: string }) {
  return (
    <button type="button" className="go" data-goto="" data-go={kind} onClick={() => gotoAction(kind)}>
      {label}
    </button>
  );
}

export const RailGo = memo(function RailGo({ needs, busy }: { readonly needs: Needs | null; readonly busy: boolean }) {
  const label = needs?.action || 'Open';
  const cta = needs?.cta;
  if (cta?.kind === 'ship-confirm') return <ShipGo label={label} busy={busy} />;
  if (cta?.kind === 'retry-ship') return <RetryShipGo label={label} />;
  if (cta?.kind === 'merge') return <MergeGo label={label} repo={cta.repo} busy={busy} />;
  if (cta?.kind === 'resolve-conflicts' || cta?.kind === 'resolve-panel') return null;
  if (!cta || cta.kind === 'open-session') return <OpenSessionGo label={label} />;
  return <GotoGo label={label} kind={cta.kind} />;
});
