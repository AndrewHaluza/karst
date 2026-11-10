/**
 * The Inside block's ticking leaves (migration plan A4). The host re-sends the snapshot every second while work
 * runs; what actually moves is a clock, a running row's elapsed time and its token count. Each of those is read by
 * ONE small component through its own narrow `useSlice`, and the structural frame (`insideSlices.frameOf`) ignores
 * them, so a live push renders only these and never the ledger, the evidence or the graph.
 *
 * A leaf renders its own wrapper (and the separator that goes with it), so whether the fact exists at all is also
 * the leaf's call: a duration that appears or disappears never needs the parent.
 */
import { useMemo } from 'react';
import { TokenPill } from './InsideParts.js';
import { liveDuration, nodeAge, pickDuration, pickTime, pickTokens, rowField, rowTiming, stageClock, timelineTokens } from './insideSlices.js';
import { useSlice } from './useSlice.js';

/** The header's `started 12:23:06 · 51.7s`. */
export function StageClock({ stage }: { readonly stage: string }) {
  const clock = useSlice(useMemo(() => stageClock(stage), [stage]));
  return <span className="inside-meta">{clock}</span>;
}

/** The running operation's elapsed time, with its separator; nothing while the operation states none. */
export function LiveDuration({ stage }: { readonly stage: string }) {
  const duration = useSlice(useMemo(() => liveDuration(stage), [stage]));
  if (!duration) return null;
  return (
    <>
      <span className="sep">·</span>
      <span className="duration">{duration}</span>
    </>
  );
}

export function RowTime({ stage, id }: { readonly stage: string; readonly id: string }) {
  const time = useSlice(useMemo(() => rowField(stage, id, pickTime), [stage, id]));
  return <span className="op-time">{time || null}</span>;
}

export function RowDuration({ stage, id }: { readonly stage: string; readonly id: string }) {
  const d = useSlice(useMemo(() => rowField(stage, id, pickDuration), [stage, id]));
  const time = useSlice(useMemo(() => rowField(stage, id, pickTime), [stage, id]));
  // The start time is the duration's title too: the narrow tier hides the time column and keeps this cell (UI-R41).
  const title = [d?.exact, time ? `started ${time}` : ''].filter(Boolean).join(' · ');
  return (
    <span className="duration" title={title || undefined}>
      {d?.text || null}
    </span>
  );
}

/** A process row's Σ pill (live while the row runs). */
export function RowTokens({ stage, id }: { readonly stage: string; readonly id: string }) {
  const t = useSlice(useMemo(() => rowField(stage, id, pickTokens), [stage, id]));
  return <TokenPill t={t?.tokens} />;
}

/** The Σ pill of one session-timeline row. */
export function TimelineTokens({ stage, id, index }: { readonly stage: string; readonly id: string; readonly index: number }) {
  const t = useSlice(useMemo(() => timelineTokens(stage, id, index), [stage, id, index]));
  return <TokenPill t={t?.tokens} />;
}

/** The two timing cells of one evidence row (UI-R41: both always emitted, empty when absent). Only a row with a status shows them. */
export function RowTimingCells({ stage, id, index, status }: { readonly stage: string; readonly id: string; readonly index: number; readonly status: string | undefined }) {
  const t = useSlice(useMemo(() => rowTiming(stage, id, index), [stage, id, index]));
  const started = status && t?.time ? `started ${t.time}` : undefined;
  return (
    <>
      <span className="ev-time" title={started}>
        {status ? t?.time || null : null}
      </span>
      <span className="ev-dur" title={(status && [t?.exact, t?.time ? `started ${t.time}` : ''].filter(Boolean).join(' · ')) || undefined}>
        {status ? t?.duration || null : null}
      </span>
    </>
  );
}

/** The age of one graph node. Whether the node has one at all is the leaf's call. */
export function GraphNodeAge({ stage, id, index }: { readonly stage: string; readonly id: string; readonly index: number }) {
  const age = useSlice(useMemo(() => nodeAge(stage, id, index), [stage, id, index]));
  return age ? <span className="graph-node-age">{age}</span> : null;
}
