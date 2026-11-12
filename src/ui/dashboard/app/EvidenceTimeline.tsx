/**
 * The session timeline: ONE continuous rail, three row shapes. The shape comes from `role` / `connector`, closed
 * structural fields, NEVER from parsing the label, which is prose. Each row's Σ pill is a ticking leaf
 * (`TimelineTokens`), so a token count advancing does not re-render the rail.
 */
import type { EvidenceRow } from '../../../model/inside/types.js';
import { agentName } from './AgentIcon.js';
import { TimelineTokens } from './InsideClocks.js';
import { Overflow } from './EvidenceParts.js';
import { CoreMark, InsideActionButton, OverflowButton } from './InsideParts.js';
import { statusWord } from './insideText.js';

function Tail({ r, stage, id, index }: { readonly r: EvidenceRow; readonly stage: string; readonly id: string; readonly index: number }) {
  return (
    <span className="timeline-tail">
      {r.action ? <InsideActionButton action={r.action} /> : null}
      {/* Last in the tail, like the session row's Σ pill: one Σ column before the time columns (UI-R41). */}
      <TimelineTokens stage={stage} id={id} index={index} />
    </span>
  );
}

/** The timing is two fixed grid cells after the action, empty when absent, so every row of the rail lines up (UI-R41). */
function Timing({ r }: { readonly r: EvidenceRow }) {
  const title = [r.durationExact, r.time ? `started ${r.time}` : ''].filter(Boolean).join(' · ');
  return (
    <>
      <span className="segment-window tl-time">{r.time || null}</span>
      <span className="segment-window tl-dur" title={title || undefined}>{r.duration || null}</span>
    </>
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
          <CoreMark provider={r.provider} core={agentName(r.provider)} tip={r.detail || agentName(r.provider)} />
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
        <Timing r={r} />
      </div>
    );
  }
  if (r.role === 'identity') {
    // A completed session's start reads as part of the delivery: the hollow start node gives way to the same green check the done row carries.
    return (
      <div className="timeline-row timeline-start">
        <span className="timeline-slot">
          {r.status === 'pass' ? <span className="glyph phase-status pass" role="img" aria-label="passed" /> : <span className="timeline-node start" aria-hidden="true" />}
        </span>
        <span className="timeline-start-label">{r.label}</span>
        <IdentityCell r={r} />
        {tail}
        <Timing r={r} />
      </div>
    );
  }
  const status = r.status || 'pending';
  return (
    <div className={`timeline-row phase-row${status === 'run' ? ' current' : ''}`}>
      <span className="timeline-slot phase-rail">
        <span className={`glyph phase-status ${status}`} role="img" aria-label={statusWord(status)} />
      </span>
      <span className="phase-name">{r.label}</span>
      <span className={`phase-detail ${status}`}>{r.detail || ''}</span>
      <span className="phase-tail" />
      <span className="phase-time tl-time">{r.time || null}</span>
      <span className="phase-time tl-dur" title={[r.durationExact, r.time ? `started ${r.time}` : ''].filter(Boolean).join(' · ') || undefined}>{r.duration || null}</span>
    </div>
  );
}

/**
 * The bounded remainder under the rail: the text button 'chevron-down + N more'. Its full sentence is the title and the
 * accessible name (UI-R21/R24). A remainder without a count or without an action keeps the plain note.
 */
function TimelineOverflow({ o }: { readonly o: EvidenceRow | undefined }) {
  if (!o || o.hidden === undefined || !o.action) return <Overflow o={o} />;
  return (
    <div className="timeline-overflow">
      <OverflowButton action={o.action} hidden={o.hidden} />
    </div>
  );
}

export function EvidenceTimeline({ rows, stage, id }: { readonly rows: readonly EvidenceRow[]; readonly stage: string; readonly id: string }) {
  // The bounded remainder (`role: 'event'`) is not history: it is the control that reveals the withheld rows, drawn
  // below the rail like the other bodies' remainder, so it stays reachable where `.timeline-tail` is hidden.
  const more = rows.find((r) => r.role === 'event');
  return (
    <>
      <div className="session-segments">
        {rows.map((r, i) =>
          r.role === 'event' ? null : (
            // The rail is ordered history: a row keeps its place, so its position is part of its identity.
            <Row key={`${i}:${r.label}`} r={r} stage={stage} id={id} index={i} />
          ),
        )}
      </div>
      <TimelineOverflow o={more} />
    </>
  );
}
