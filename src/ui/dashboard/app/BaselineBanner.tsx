/**
 * The blocked banner's baseline-review line (@arch:BASELINE-REVIEW): ONE amber line that says how many changed
 * screenshots wait for the user, with Review (opens the review overlay, `BaselineOverlay.tsx`) and Approve all.
 * No row and no image lives here, so 190 changed baselines cost the dashboard one line. A baseline review is a
 * needs-you block, not a fault, so the strip is amber (`BlockedBanner.css`), not the failed tint.
 *
 * Approve all covers the entries still PENDING: it never approves a rejected entry behind the user's back.
 */
import { useCallback } from 'react';
import type { BaselineReviewRow } from '../baselineRows.js';
import { countRows, normaliseRows } from './baselineGroups.js';
import { useDashboardSend, useOverlays } from './DashboardAppContext.js';
import { Icon } from './Icon.js';
import { usePendingAction } from './usePendingAction.js';

export const BASELINE_BLOCK_ID = 'baseline-review';

const plural = (n: number, one: string, many: string): string => (n === 1 ? one : many);

export function BaselineBanner({ entries }: { readonly entries: readonly BaselineReviewRow[] }) {
  const send = useDashboardSend();
  const overlays = useOverlays();
  const rows = normaliseRows(entries);
  const counts = countRows(rows);
  const pending = rows.filter((r) => r.decision === 'pending').map((r) => r.index);
  const onApprove = usePendingAction(useCallback((requestId: string) => send.baselineApprove(BASELINE_BLOCK_ID, pending, requestId), [send, pending.join(',')]));
  const verb = plural(counts.all, 'needs', 'need');
  const noun = plural(counts.all, 'screenshot', 'screenshots');
  const rejected = counts.rejected > 0 ? ` · ${counts.rejected} rejected` : '';
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
        {pending.length > 0 ? (
          <button
            type="button"
            className="k-btn k-btn--secondary k-btn--sm"
            data-act="baseline-approve"
            data-block-id={BASELINE_BLOCK_ID}
            data-indices={pending.join(',')}
            onClick={onApprove}
          >
            <Icon name="check" size={14} /> Approve all
          </button>
        ) : null}
      </div>
    </div>
  );
}
