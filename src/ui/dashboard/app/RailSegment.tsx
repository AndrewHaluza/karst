/**
 * One segment of the stage track, with what is drawn inside it: the glyph, the name, then the needs-you
 * wording and control (current stage only), impl's approach pips, or the duration, and last the retry meter.
 * Same DOM, classes and ARIA as the vanilla `renderTrack` it replaced.
 *
 * The segment is a <div> wrapper, never a button: it holds the select control AND, when the stage is parked
 * on the user, the action control, and a <button> may not contain a <button>.
 */
import { memo } from 'react';
import { RailGo } from './RailGo.js';
import { durationText, look, meterLabel, segAria, showsApproach, type Approach, type RailSeg, type Retry } from './railText.js';
import { structurallyEqual } from './useSlice.js';

/** impl's approach: its NAME and one pip per declared phase. A pip fills only for a phase the agent REPORTED. */
function Pips({ approach }: { readonly approach: Approach }) {
  const phases = approach.phases ?? [];
  const done = new Set(approach.reported ?? []);
  const latest = (approach.reported ?? []).slice(-1)[0];
  const caption = latest ? `${latest} · ${approach.id}` : approach.id;
  // Nothing to say only when there is genuinely nothing: no name AND no phase.
  if (!caption && phases.length === 0) return null;
  return (
    <span className="pips">
      {phases.map((p) => (
        <span key={p} className={done.has(p) ? 'p on' : 'p'} title={`${p}${done.has(p) ? ' — reported' : ' — not reported'}`} />
      ))}
      <span className="pn">{caption}</span>
    </span>
  );
}

/**
 * The retry meter IS the fix control: it is how `fix` stays selectable now that the node is gone. One tick
 * per ALLOWED attempt (the host's cap, never a literal), filled per attempt spent.
 */
function Meter({ retry, onSelect }: { readonly retry: Retry; readonly onSelect: (stage: string) => void }) {
  const label = meterLabel(retry);
  return (
    <button type="button" className={retry.live ? 'fixm' : 'fixm spent'} data-stage="fix" aria-label={label} title={label} onClick={() => onSelect('fix')}>
      <span className="ticks">
        {Array.from({ length: retry.cap }, (_, n) => (
          <span key={n} className={n < retry.spent ? 'tk on' : 'tk'} />
        ))}
      </span>
      <span className="tx">{`fix ${retry.spent}/${retry.cap}`}</span>
      {retry.returnsTo ? <span className="ret">{`↩ ${retry.returnsTo}`}</span> : null}
    </button>
  );
}

export interface SegmentProps {
  readonly seg: RailSeg;
  readonly sel: boolean;
  /** The approach, handed down only to the segment that may draw it. */
  readonly approach: Approach | null;
  /** The shared ship / merge request behind this segment's control is in flight. */
  readonly busy: boolean;
  readonly onSelect: (stage: string) => void;
}

function SegmentView({ seg, sel, approach, busy, onSelect }: SegmentProps) {
  const k = seg.cell.stageKey;
  const l = look(seg);
  const aria = segAria(seg, approach);
  const cls = ['seg', `stg-${k}`, l.statusClass, seg.current ? 'cur' : '', sel ? 'sel' : ''].filter(Boolean).join(' ');
  const duration = durationText(seg.cell);
  return (
    <div className={cls}>
      <button type="button" className="pick" data-stage={k} aria-pressed={sel} aria-label={aria} title={aria} onClick={() => onSelect(k)} />
      <span className="g">{l.running ? <span className="spin" aria-hidden="true" /> : l.glyph}</span>
      {/* Both name forms ship and the CSS picks one: swapping the text here would mean re-rendering on every resize. */}
      <span className="nm">
        {seg.current ? (
          <>
            <span className="full">{l.title}</span>
            <span className="abbr">{k}</span>
          </>
        ) : (
          k
        )}
      </span>
      {seg.current && l.needs ? (
        <>
          <span className="mt">{seg.needs ? seg.needs.detail : ''}</span>
          <RailGo needs={seg.needs} busy={busy} />
        </>
      ) : showsApproach(seg, approach) ? (
        <Pips approach={approach} />
      ) : duration ? (
        <span className="mt">{duration}</span>
      ) : null}
      {/* The meter is APPENDED, never assigned into the same slot as the meta: a retried gate has both. */}
      {seg.retry ? <Meter retry={seg.retry} onSelect={onSelect} /> : null}
    </div>
  );
}

/** Re-renders only for a change in what THIS segment draws: a 1 Hz push that moved one segment leaves the rest alone. */
export const Segment = memo(
  SegmentView,
  (a, b) => a.sel === b.sel && a.busy === b.busy && a.onSelect === b.onSelect && structurallyEqual(a.seg, b.seg) && structurallyEqual(a.approach, b.approach),
);
