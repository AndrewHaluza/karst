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
import { liveDuration, pickDuration, pickTime, pickTokens, rowField, stageClock, timelineTokens } from './insideSlices.js';
import { useSlice } from './useSlice.js';

/** The header's `started 12:23:06 · 51.7s · attempt 1`. */
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
  return time ? <span className="op-time">{time}</span> : null;
}

export function RowDuration({ stage, id }: { readonly stage: string; readonly id: string }) {
  const d = useSlice(useMemo(() => rowField(stage, id, pickDuration), [stage, id]));
  if (!d?.text) return null;
  return (
    <span className="duration" title={d.exact || undefined}>
      {d.text}
    </span>
  );
}

/** A process row's Σ pill (live while the row runs). */
export function RowTokens({ stage, id }: { readonly stage: string; readonly id: string }) {
  const t = useSlice(useMemo(() => rowField(stage, id, pickTokens), [stage, id]));
  return <TokenPill t={t?.tokens} live={t?.live ?? false} />;
}

/** The Σ pill of one session-timeline row. */
export function TimelineTokens({ stage, id, index }: { readonly stage: string; readonly id: string; readonly index: number }) {
  const t = useSlice(useMemo(() => timelineTokens(stage, id, index), [stage, id, index]));
  return <TokenPill t={t?.tokens} live={t?.live ?? false} />;
}
