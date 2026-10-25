/**
 * The dashboard's stage rail, rendered by React into the page's static `#rail` root through a
 * `RegionPortal` (the region parity snapshot pins the root, so `inReactIsland()` treats `#rail` as an island
 * until Phase 12). Same DOM as the vanilla `renderTrack` it replaced.
 *
 * React owns the stage selection (`stageSelection.ts`), shared with the Inside block beside it: a pick re-points
 * the strip in the same turn. The page only persists it (`vscode.setState`, A3), through a one-way event.
 *
 * The track measures rather than positions: after every render and on resize it picks one of three
 * degradation classes (`snug`, `tight`, `bare`) and positions nothing, so a measurement taken before layout can
 * only under-degrade for a frame. The classes are written on the node, never through `className`.
 */
import { memo, useEffect, useLayoutEffect, useRef } from 'react';
import { useOps, useSelection } from './DashboardAppContext.js';
import { RegionPortal } from './RegionPortal.js';
import { Segment } from './RailSegment.js';
import { selectRail, type RailSlice } from './railSlices.js';
import { ctaOf, showsApproach, type RailSeg } from './railText.js';
import { shownStage } from './stageSelection.js';
import { useSlice } from './useSlice.js';
import './Rail.css';
import './RailRing.css';

/** Three steps, measured: each drops something a segment merely ANNOTATES, never the name or the action of the current one. */
function place(track: HTMLElement | null): void {
  const lane = track?.firstElementChild as HTMLElement | null | undefined;
  if (!track || !lane) return;
  const over = (): boolean => lane.scrollWidth > lane.clientWidth + 1;
  track.classList.remove('snug', 'tight', 'bare');
  if (!over()) return;
  track.classList.add('snug');
  if (!over()) return;
  track.classList.add('tight');
  if (over()) track.classList.add('bare');
}

/** The ship / merge control of this segment is busy when the operation it shares with the header / PR panel is in flight. */
function useBusy(): (s: RailSeg) => boolean {
  const ops = useOps();
  return (s) => {
    const cta = ctaOf(s);
    if (!s.current || s.needsUser !== true || !cta) return false;
    return cta.kind === 'ship-confirm' ? ops.shipping : cta.kind === 'merge' ? ops.merging.has(cta.repo) : false;
  };
}

function Track({ slice, sel, select }: { readonly slice: RailSlice; readonly sel: string; readonly select: (stage: string) => void }) {
  const trackRef = useRef<HTMLDivElement>(null);
  const busyOf = useBusy();
  useLayoutEffect(() => {
    place(trackRef.current);
  });
  useEffect(() => {
    // The DOM did not change but the room did: a panel drag, the document finishing, web fonts settling.
    const measure = (): void => place(trackRef.current);
    window.addEventListener('resize', measure);
    window.addEventListener('load', measure);
    void document.fonts?.ready.then(measure);
    return () => {
      window.removeEventListener('resize', measure);
      window.removeEventListener('load', measure);
    };
  }, []);
  return (
    <div className="track" ref={trackRef}>
      <div className="lane">
        {slice.main.map((seg) => (
          <Segment
            key={seg.cell.stageKey}
            seg={seg}
            sel={sel === seg.cell.stageKey}
            approach={showsApproach(seg, slice.approach) ? slice.approach : null}
            busy={busyOf(seg)}
            onSelect={select}
          />
        ))}
      </div>
    </div>
  );
}

export const Rail = memo(function Rail() {
  const slice = useSlice(selectRail);
  const { selection, select } = useSelection();
  // The selection is local (never in DashboardState), so a push cannot reset it; with none it follows the ticket.
  const sel = slice ? shownStage(selection.selected, slice) : '';
  return <RegionPortal id="rail">{slice ? <Track slice={slice} sel={sel} select={select} /> : null}</RegionPortal>;
});
