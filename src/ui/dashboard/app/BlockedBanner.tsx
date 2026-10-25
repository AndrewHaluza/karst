/**
 * The blocked banner: why karst could not ask the CURRENT stage's question (`parkGateStage` /
 * `clearStageBlock`), plus the recovery actions. Rendered by React into the page's static `#blocked` root
 * (the region parity snapshot pins it, so `inReactIsland()` treats `#blocked` as an island until Phase 12, and
 * the root's `hidden` class is toggled on the node in a layout effect). Same DOM as the vanilla `renderBlocked`.
 *
 * Reads `state.currentStage.blocked` only: a stage that is not the ticket's current one is never the thing a
 * Resume click here could act on. Three kinds keep the banner:
 *
 *  - a resumable fault: the reason plus Resume. The resumability verdict is the host's `resumable` flag
 *    (`blockedDetail`, model/stepper.ts), never a reason-string match here.
 *  - `usage-limit` (K11, D159): non-resumable, since a retry would re-run the model that is out of allowance,
 *    but the user's to resolve, so the banner carries the reason and the three park actions (the vanilla
 *    page's recorded exception, re-homed here per A5): Pick agent/model…, Retry same, Dismiss.
 *  - `baseline-review`: non-resumable, only the user's decision clears it (`BaselineReview.tsx`).
 *
 * `awaiting-merge` renders NOTHING: it is a normal wait, already surfaced by the header's chip and the Inside
 * ship view's merge rows, so a third surface would be the legacy blocked banner this fault chain removed.
 *
 * The buttons are runtime-pending and keep one className each: the runtime's `is-pending` lives on that node.
 * The key they carry is `data-stagekey`, NOT `data-stage`: the vanilla delegator selects a stage on any
 * `[data-stage]` ancestor, so these buttons must never also re-point the Inside panel.
 */
import { memo, useCallback, useLayoutEffect } from 'react';
import type { BaselineReviewRow } from '../baselineRows.js';
import { BaselineReview, useBaselineDrafts, type BaselineDrafts } from './BaselineReview.js';
import type { DashboardSnapshot } from './dashboardStore.js';
import { useDashboardSend } from './DashboardAppContext.js';
import { STAGE_TITLE } from './railText.js';
import { RegionPortal } from './RegionPortal.js';
import { usePendingAction } from './usePendingAction.js';
import { useSlice } from './useSlice.js';
import './BlockedBanner.css';

interface BannerSlice {
  readonly ticketId: number;
  readonly stageKey: string;
  readonly kind: string;
  readonly reason: string;
  /** Only while the block is a baseline review. */
  readonly baselines: readonly BaselineReviewRow[];
}

/** null when there is nothing for the banner to say. */
const selectBanner = (snapshot: DashboardSnapshot): BannerSlice | null => {
  const s = snapshot.state;
  const cell = s?.currentStage;
  const blocked = cell?.blocked;
  if (!s || !cell || !blocked) return null;
  const review = blocked.kind === 'baseline-review';
  if (!(blocked.resumable !== false || review || blocked.kind === 'usage-limit')) return null;
  return {
    ticketId: s.ticketId,
    stageKey: cell.stageKey,
    kind: blocked.kind,
    reason: blocked.reason,
    baselines: review ? (s.baselineReview ?? []) : [],
  };
};

interface ActionProps {
  readonly ticketId: number;
  readonly stageKey: string;
}

/** Why the stage stopped: machine truth, so the reason is monospace. */
const Head = ({ title, reason }: { readonly title: string; readonly reason: string }) => (
  <>
    <div className="ftitle">{title}</div>
    <div className="freason">{reason}</div>
  </>
);

function ParkActions({ ticketId, stageKey }: ActionProps) {
  const send = useDashboardSend();
  const key = stageKey as Parameters<typeof send.usageLimitPick>[1];
  const onPick = usePendingAction(useCallback((requestId: string) => send.usageLimitPick(ticketId, key, requestId), [send, ticketId, key]));
  const onRetry = usePendingAction(useCallback((requestId: string) => send.usageLimitRetry(ticketId, key, requestId), [send, ticketId, key]));
  const onDismiss = usePendingAction(useCallback((requestId: string) => send.usageLimitDismiss(ticketId, key, requestId), [send, ticketId, key]));
  return (
    <div className="facts">
      <button type="button" className="k-btn k-btn--primary k-btn--sm" data-act="usage-limit-pick" data-stagekey={stageKey} onClick={onPick}>
        Pick agent/model…
      </button>
      <button type="button" className="k-btn k-btn--secondary k-btn--sm" data-act="usage-limit-retry" data-stagekey={stageKey} onClick={onRetry}>
        Retry same
      </button>
      <button type="button" className="k-btn k-btn--secondary k-btn--sm" data-act="usage-limit-dismiss" data-stagekey={stageKey} onClick={onDismiss}>
        Dismiss
      </button>
    </div>
  );
}

function Resume({ ticketId, stageKey }: ActionProps) {
  const send = useDashboardSend();
  const key = stageKey as Parameters<typeof send.stageResume>[1];
  const onClick = usePendingAction(useCallback((requestId: string) => send.stageResume(ticketId, key, requestId), [send, ticketId, key]));
  return (
    <div className="facts">
      <button
        type="button"
        className="k-btn k-btn--secondary k-btn--sm"
        data-act="stage-resume"
        data-stagekey={stageKey}
        title="Clear the block and let karst try this stage again"
        onClick={onClick}
      >
        Resume
      </button>
    </div>
  );
}

function Body({ slice, drafts }: { readonly slice: BannerSlice; readonly drafts: BaselineDrafts }) {
  const { ticketId, stageKey, kind, reason } = slice;
  if (kind === 'usage-limit') {
    return (
      <>
        <Head title="Provider out of quota" reason={reason} />
        <ParkActions ticketId={ticketId} stageKey={stageKey} />
      </>
    );
  }
  if (kind === 'baseline-review') return <BaselineReview entries={slice.baselines} reason={reason} drafts={drafts} />;
  return (
    <>
      <Head title={`${STAGE_TITLE[stageKey] ?? stageKey} is blocked`} reason={reason} />
      <Resume ticketId={ticketId} stageKey={stageKey} />
    </>
  );
}

export const BlockedBanner = memo(function BlockedBanner() {
  const slice = useSlice(selectBanner);
  // The drafts of an open reject form live here, in the always-mounted banner, so they outlive the review surface.
  const drafts = useBaselineDrafts();
  const shown = slice !== null;
  useLayoutEffect(() => {
    document.getElementById('blocked')?.classList.toggle('hidden', !shown);
  }, [shown]);
  return <RegionPortal id="blocked">{slice ? <Body slice={slice} drafts={drafts} /> : null}</RegionPortal>;
});
