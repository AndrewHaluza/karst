/**
 * The session timeline: ONE continuous rail, three row shapes. The shape comes from `role` / `connector`, closed
 * structural fields, NEVER from parsing the label, which is prose. Each row's Σ pill is a ticking leaf
 * (`TimelineTokens`), so a token count advancing does not re-render the rail.
 */
import type { EvidenceRow } from '../../../model/inside/types.js';
import { RuntimeIcon } from './AgentIcon.js';
import { TimelineTokens } from './InsideClocks.js';
import { InsideActionButton } from './InsideParts.js';
import { statusWord } from './insideText.js';

function Tail({ r, stage, id, index }: { readonly r: EvidenceRow; readonly stage: string; readonly id: string; readonly index: number }) {
  return (
    <span className="timeline-tail">
      <TimelineTokens stage={stage} id={id} index={index} />
      {/* The start stamp renders BESIDE the duration in the tail: every row dates at its end, next to the span it measures. */}
      {r.time ? <span className="segment-window">{r.time}</span> : null}
      {r.duration ? <span className="segment-window">{r.duration}</span> : null}
      {r.action ? <InsideActionButton action={r.action} /> : null}
    </span>
  );
}

/**
 * The identity cell states an identity ONLY when the row carries one: a provider-keyed row shows its core icon and
 * identity prose in the core's own blue. A provider-less identity row (the run start) has no identity to claim, and
 * rendering one would borrow the identity chip's colour for something that is not an identity.
 */
function IdentityCell({ r }: { readonly r: EvidenceRow }) {
  return (
    <span className="switch-value">
      {r.provider ? (
        <span className="agent-id">
          <RuntimeIcon kind="agent" provider={r.provider} />
          <span className="agent-core">{r.detail || ''}</span>
        </span>
      ) : (
        <span />
      )}
    </span>
  );
}

function Row({ r, stage, id, index }: { readonly r: EvidenceRow; readonly stage: string; readonly id: string; readonly index: number }) {
  const tail = <Tail r={r} stage={stage} id={id} index={index} />;
  if (r.connector === 'switch' || r.connector === 'resume') {
    const word = r.connector === 'switch' ? 'Provider switched here' : 'Session resumed here';
    return (
      <div className="timeline-row switch-event">
        <span className="timeline-slot switch-slot" aria-hidden="true">
          <span className="switch-branch" />
        </span>
        <span className="switch-label" title={word}>
          <span className="switch-arrow" aria-hidden="true">
            ↳
          </span>
          <span>{r.label}</span>
        </span>
        <IdentityCell r={r} />
        {tail}
      </div>
    );
  }
  if (r.role === 'identity') {
    // A completed session's start reads as part of the delivery: the hollow start node gives way to the same green check the done row carries.
    return (
      <div className="timeline-row timeline-start">
        <span className="timeline-slot">
          {r.status === 'pass' ? <span className="glyph phase-status pass" aria-label="passed" /> : <span className="timeline-node start" aria-hidden="true" />}
        </span>
        <span className="timeline-start-label">{r.label}</span>
        <IdentityCell r={r} />
        {tail}
      </div>
    );
  }
  const status = r.status || 'pending';
  return (
    <div className={`timeline-row phase-row${status === 'run' ? ' current' : ''}`}>
      <span className="timeline-slot phase-rail">
        <span className={`glyph phase-status ${status}`} aria-label={statusWord(status)} />
      </span>
      <span className="phase-name">{r.label}</span>
      <span className={`phase-detail ${status}`}>{r.detail || ''}</span>
      <span className="phase-time">{r.time || r.duration || ''}</span>
    </div>
  );
}

export function EvidenceTimeline({ rows, stage, id }: { readonly rows: readonly EvidenceRow[]; readonly stage: string; readonly id: string }) {
  return (
    <div className="session-segments">
      {rows.map((r, i) => (
        // The rail is ordered history: a row keeps its place, so its position is part of its identity.
        <Row key={`${i}:${r.label}`} r={r} stage={stage} id={id} index={i} />
      ))}
    </div>
  );
}
