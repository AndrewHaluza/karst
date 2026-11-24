/**
 * The blocked banner's baseline-review line (@arch:BASELINE-REVIEW): ONE amber line that says how many changed
 * screenshots wait for the user, with Review (opens the review overlay, `BaselineOverlay.tsx`), Approve all and, once
 * an entry is rejected, Send. No row and no image lives here, so 190 changed baselines cost the dashboard one line. A
 * baseline review is a needs-you block, not a fault, so the strip is amber (`BlockedBanner.css`), not the failed tint.
 *
 * Approve all covers the entries still PENDING: it never approves a rejected entry behind the user's back. With a
 * rejected entry it also sends them to `fix`, so its label names that. Send alone sends the rejected entries.
 */
import { useCallback } from 'react';
import type { BaselineReviewRow } from '../baselineRows.js';
import { BASELINE_BLOCK_ID, approveSendLabel, countRows, normaliseRows } from './baselineGroups.js';
import { SendRejectionsButton } from './BaselineActions.js';
import { useDashboardSend, useOverlays } from './DashboardAppContext.js';
import { Icon } from './Icon.js';
import { usePendingAction } from './usePendingAction.js';

export { BASELINE_BLOCK_ID };

const plural = (n: number, one: string, many: string): string => (n === 1 ? one : many);

export function BaselineBanner({ entries }: { readonly entries: readonly BaselineReviewRow[] }) {
  const send = useDashboardSend();
  const overlays = useOverlays();
  const rows = normaliseRows(entries);
  const counts = countRows(rows);
  const pendingCount = rows.filter((r) => r.decision === 'pending').length;
  // Approve all names only the block: the host decides which entries are pending, so no list size applies.
  const onApprove = usePendingAction(useCallback((requestId: string) => send.baselineApproveAll(BASELINE_BLOCK_ID, requestId), [send]));
  const verb = plural(counts.all, 'needs', 'need');
  const noun = plural(counts.all, 'screenshot', 'screenshots');
  const rejected = counts.rejected > 0 ? ` · ${counts.rejected} rejected` : '';
  const approveLabel = counts.rejected > 0 ? approveSendLabel(pendingCount, counts.rejected) : 'Approve all';
  return (
    <div className="blbanner" data-region="blocked-banner">
      <span className="glyph wait" role="img" aria-label="Needs review" />
      <span className="ftext">
        <span className="ftitle">Review baselines</span>
        <span className="freason">{` · ${counts.pending} of ${counts.all} changed ${noun} ${verb} you${rejected}`}</span>
      </span>
      <div className="facts">
        <button type="button" className="k-btn k-btn--primary k-btn--sm" data-act="baseline-open" onClick={() => overlays.openBaselines()}>
          <Icon name="eye" size={14} /> Review
        </button>
        {pendingCount > 0 ? (
          <button
            type="button"
            className="k-btn k-btn--secondary k-btn--sm"
            data-act="baseline-approve-all"
            data-block-id={BASELINE_BLOCK_ID}
            onClick={onApprove}
          >
            <Icon name="check" size={14} /> {approveLabel}
          </button>
        ) : null}
        {counts.rejected > 0 ? <SendRejectionsButton count={counts.rejected} /> : null}
      </div>
    </div>
  );
}
