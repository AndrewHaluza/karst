/**
 * Done: the hero line, the three-block receipt grid, the Timing strip, then the delivery lines, the last of these
 * behind the receipt's own inner <details>: the overview stats are always visible and only the details expand.
 * Hero / blocks / timing are optional; a receipt that carries only rows renders exactly what it always did, as the
 * plain line list behind the Details disclosure. The host ships every string verbatim (UI-R31).
 */
import { Fragment } from 'react';
import type { ProcessEvidenceView } from '../../../model/inside/types.js';
import { EvAction, PrState } from './EvidenceParts.js';
import { ObjLink } from './InsideParts.js';
import { INSIDE_ACTION_TITLE, statusWord, withKeys } from './insideText.js';

type Receipt = Extract<ProcessEvidenceView, { kind: 'receipt' }>;

function Lines({ ev }: { readonly ev: Receipt }) {
  return (
    <details className="done-details">
      <summary>
        <span className="done-chev" aria-hidden="true" />
        Details
      </summary>
      <div className="done-detail-body">
        <div className="done-lines">
          {withKeys(ev.rows, (r) => `${r.label}/${r.detail ?? ''}`).map(([key, r]) => (
            <div className="done-line" key={key}>
              <span className="done-key">{r.label}</span>
              <span className="done-copy">
                {/* A delivery line's PR number IS its link (UI-R09c): the open-pr action rides the number itself. */}
                {r.action && r.action.kind === 'open-pr' ? <ObjLink text={r.detail} action={r.action} cls="pr-link" title={INSIDE_ACTION_TITLE['open-pr'] ?? ''} /> : r.detail || ''}
                <PrState state={r.prState} />
              </span>
              {r.action && r.action.kind !== 'open-pr' ? (
                <EvAction r={r} />
              ) : (
                <span className="done-state">
                  {r.time ? <span className="ev-time">{r.time}</span> : null}
                  {r.time ? ' · ' : null}
                  {r.duration || statusWord(r.status)}
                </span>
              )}
            </div>
          ))}
        </div>
      </div>
    </details>
  );
}

export function EvidenceReceipt({ ev }: { readonly ev: Receipt }) {
  const details = ev.rows.length ? <Lines ev={ev} /> : null;
  if (!ev.hero && !(ev.blocks && ev.blocks.length) && !ev.timing) return details;
  return (
    <div className="done-receipt">
      {ev.hero ? (
        <div className="done-hero">
          <span className="done-check glyph pass" aria-label="delivered" />
          <span className="done-hero-main">{ev.hero.title}</span>
          <span className="done-hero-sub">{ev.hero.summary}</span>
          {ev.hero.time ? <span className="done-hero-time">{ev.hero.time}</span> : null}
        </div>
      ) : null}
      {ev.blocks && ev.blocks.length ? (
        <div className="receipt-grid">
          {withKeys(ev.blocks, (b) => b.label).map(([key, b]) => (
            <div className="receipt-block" key={key}>
              <div className="receipt-label">{b.label}</div>
              <div className="receipt-value">{b.value}</div>
              {b.details && b.details.length ? (
                <div className="receipt-detail">
                  {withKeys(b.details, (d) => d).map(([dkey, d], i) => (
                    <Fragment key={dkey}>
                      {i > 0 ? <br /> : null}
                      {d}
                    </Fragment>
                  ))}
                </div>
              ) : null}
              {b.breakdown && b.breakdown.length ? (
                <div className="ai-usage-breakdown">
                  {withKeys(b.breakdown, (i) => i.label).map(([bkey, i]) => (
                    <span className="ai-usage-item" key={bkey}>
                      <strong>{i.amount}</strong>
                      {` ${i.label}`}
                    </span>
                  ))}
                </div>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
      {/* The Timing strip: label, total and the pre-joined item line verbatim; the sum of the stated durations IS the stated total by construction (host-side). */}
      {ev.timing ? (
        <div className="done-timing">
          <span className="done-timing-label">{ev.timing.label}</span>
          <span className="done-timing-value">{ev.timing.total}</span>
          <span className="done-timing-items">{ev.timing.items}</span>
        </div>
      ) : null}
      {details}
    </div>
  );
}
