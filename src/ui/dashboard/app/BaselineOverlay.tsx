/**
 * The baseline review overlay (@arch:BASELINE-REVIEW, ui:UI-R39), rendered into the static `#baselineView` root while
 * the overlay stack's `baselines` field is set and a `baseline-review` block stands: header, filter chips, the grouped
 * entry list beside ONE fitted viewer, and a sticky action bar. The overlay height never depends on the entry count.
 *
 * Keys J / K (next / previous), A (approve) and R (reject) act only while focus is inside the overlay and not in a
 * text field. Each one clicks the control the user could click, so pending and disabled states apply the same way.
 * Escape is the overlay stack's: `Overlays.tsx` closes an open reject form first, then the overlay.
 *
 * Widths follow `@ui:RD-TIERS` (`BaselineOverlay.css`). When the block clears (the last approve, or a rejection that
 * sends the ticket to fix) the overlay closes itself and the dashboard shows again.
 */
import { memo, useEffect, useRef, type KeyboardEvent } from 'react';
import { ApproveButton, BaselineActions, useApprove } from './BaselineActions.js';
import { BaselineChips, BaselineList } from './BaselineList.js';
import { BaselineViewer } from './BaselineViewer.js';
import type { BaselineDrafts } from './baselineDrafts.js';
import { useBaselineDraftsState, useOverlay, useOverlays } from './DashboardAppContext.js';
import { DrillHeader } from './DrillHeader.js';
import { RegionPortal } from './RegionPortal.js';
import { useBaselineModel, type BaselineModel } from './useBaselineModel.js';
import { useOverlayRoot } from './useOverlayRoot.js';
import './BaselineOverlay.css';

/** What each bare key clicks. */
const KEY_TARGET: Readonly<Record<string, string>> = {
  j: '[data-act="baseline-next"]',
  k: '[data-act="baseline-prev"]',
  a: '[data-role="approve"]',
  r: '[data-act="baseline-reject-open"]',
};

const isTextField = (el: EventTarget | null): boolean => el instanceof HTMLElement && (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.isContentEditable);

function onKeys(e: KeyboardEvent<HTMLElement>): void {
  if (e.repeat || e.ctrlKey || e.metaKey || e.altKey || isTextField(e.target)) return;
  const target = KEY_TARGET[e.key.toLowerCase()];
  if (!target) return;
  const el = e.currentTarget.querySelector<HTMLButtonElement>(target);
  if (!el) return;
  e.preventDefault();
  el.click();
}

function Review({ model, drafts }: { readonly model: BaselineModel; readonly drafts: BaselineDrafts }) {
  const approve = useApprove(model, drafts);
  const pending = model.rows.filter((r) => r.decision === 'pending').map((r) => r.index);
  const { selected } = model;
  return (
    <>
      <DrillHeader
        trail={[{ label: 'Baselines' }]}
        actions={
          pending.length > 0 ? <ApproveButton indices={pending} label={`Approve all (${pending.length})`} primary={false} approve={approve} /> : null
        }
      />
      <div className="blsub">{`${model.ticketLabel} · ${model.stageKey} · ${model.counts.pending} open`}</div>
      <BaselineChips model={model} drafts={drafts} />
      <div className="blmain">
        <BaselineList model={model} drafts={drafts} />
        {selected ? <BaselineViewer row={selected} view={model.view} drafts={drafts} /> : <div className="blnote blviewer">Select a screenshot.</div>}
      </div>
      {selected ? <BaselineActions model={model} row={selected} drafts={drafts} approve={approve} /> : null}
    </>
  );
}

function BaselineReviewSurface({ open }: { readonly open: boolean }) {
  const overlays = useOverlays();
  const model = useBaselineModel();
  const drafts = useBaselineDraftsState();
  const root = useRef<HTMLDivElement>(null);
  const gone = open && model === null;
  // The block cleared under an open overlay: back to the dashboard.
  useEffect(() => {
    if (gone) overlays.closeBaselines();
  }, [gone, overlays]);
  // Opening puts focus inside, so the keys work without a click.
  useEffect(() => {
    if (open) root.current?.focus();
  }, [open]);
  if (!model) return null;
  return (
    <div className="blview" data-region="baseline-review" ref={root} tabIndex={-1} onKeyDown={onKeys}>
      <Review model={model} drafts={drafts} />
    </div>
  );
}

export const BaselineOverlay = memo(function BaselineOverlay() {
  const open = useOverlay((s) => s.baselines);
  useOverlayRoot('baselineView', open, 'baseline-nav');
  return <RegionPortal id="baselineView">{open ? <BaselineReviewSurface open={open} /> : null}</RegionPortal>;
});
