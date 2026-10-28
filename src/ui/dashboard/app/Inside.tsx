/**
 * The Inside block, rendered by React into the page's static `#inside` root through a `RegionPortal` (the region
 * parity snapshot pins the root as static markup). Same DOM as the
 * vanilla `renderInside` it replaced: a viewing bar, the three-cell header (stage title, the live operation, the
 * clock) with the ⋯ menu, the Deliver row, the round switcher, then the ship preview and the process ledger.
 *
 * React owns the stage selection (`stageSelection.ts`), shared with the rail. The host re-sends the snapshot every
 * second while work runs (migration plan A4): the block reads one structural FRAME that ignores the ticking facts, and
 * the clocks and token counts are leaves that read their own value (`InsideClocks.tsx`), so a live push renders only
 * those. What the user opened or switched lives in `InsideMemory`, above the block, so it survives every push.
 */
import { memo, useMemo, useState } from 'react';
import { useSelection } from './DashboardAppContext.js';
import { DeliverRow } from './DeliverRow.js';
import { AttemptTabs } from './InsideAttempts.js';
import { LiveDuration, StageClock } from './InsideClocks.js';
import { Ledger } from './InsideLedger.js';
import { InsideMemory, InsideScopeContext } from './InsideMemory.js';
import { StageMenu } from './InsideMenu.js';
import { AgentId } from './InsideParts.js';
import { RegionPortal } from './RegionPortal.js';
import { ShipPreview } from './ShipPreview.js';
import { sameIgnoringLive } from './insideLive.js';
import { frameOf, selectTicketStage, type Frame } from './insideSlices.js';
import { statusWord } from './insideText.js';
import { shownStage } from './stageSelection.js';
import { useSlice } from './useSlice.js';
import './Inside.css';
import './InsideEvidence.css';
import './InsideShipPreview.css';
import './InsideResponsive.css';

/** The header IS the current operation. No status WORD beside the glyph: the spinning arc says "running" and the amber bars say "waiting"; the word survives as the glyph's accessible name. */
function LiveLine({ stage, live }: { readonly stage: string; readonly live: Frame['live'] }) {
  if (!live) return null;
  const status = live.status || 'run';
  return (
    <>
      <span className={`glyph ${status}`} aria-label={statusWord(status)} />
      <strong>{live.label || ''}</strong>
      {live.detail ? (
        <>
          <span className="sep">·</span>
          <span className="live-copy">{live.detail}</span>
        </>
      ) : null}
      {/* The running operation's AI identity, so it does not appear only once the step finishes. */}
      {live.execution ? (
        <>
          <span className="sep">·</span>
          <span className="ai-mark">AI</span>
          <AgentId x={live.execution} />
        </>
      ) : null}
      <LiveDuration stage={stage} />
    </>
  );
}

function Block({ stage, memory }: { readonly stage: string; readonly memory: InsideMemory }) {
  const { selection, select } = useSelection();
  const frame = useSlice(useMemo(() => frameOf(stage), [stage]), sameIgnoringLive);
  const scope = useMemo(() => ({ memory, stageKey: stage, ticketId: frame?.ticketId ?? 0 }), [memory, stage, frame?.ticketId]);
  if (!frame) return null;
  const { view, menu, deliver, back } = frame;
  const anyMenu = menu.sendBack || menu.reset !== null || menu.prFeedback || menu.ci || menu.rebase || menu.retry !== null;
  const lstatus = frame.live ? frame.live.status || 'run' : '';
  return (
    <InsideScopeContext.Provider value={scope}>
      <section className={`inside${back !== null ? ' viewing' : ''}`} aria-labelledby="inside-title">
        {back !== null ? (
          <div className="vbar">
            <span>{`Viewing ${view.title} — not the current stage.`}</span>
            <span className="sp">
              <button type="button" className="k-btn k-btn--ghost k-btn--sm" data-back="" title="Return the strip to the stage the ticket is actually on" onClick={() => select(null)}>
                {`Back to ${back}`}
              </button>
            </span>
          </div>
        ) : null}
        <div className={`inside-head${menu.sendBack || menu.reset !== null || menu.prFeedback || menu.ci || menu.rebase ? ' has-actions' : ''}`} title={view.title || undefined}>
          <span className="inside-title" id="inside-title">{`Inside ${view.stageKey}`}</span>
          <span className={`inside-live ${lstatus}`}>
            <LiveLine stage={stage} live={frame.live} />
          </span>
          <StageClock stage={stage} />
          {anyMenu ? <StageMenu key={selection.epoch} stageKey={view.stageKey} menu={menu} /> : null}
        </div>
        {/* "Deliver to PR": the count line + action, ship only, hidden while nothing is undelivered. */}
        {deliver ? <DeliverRow notOnPr={deliver.notOnPr} inSandbox={deliver.inSandbox} /> : null}
        {/* ONE slot for the round row and its caption, so the ledger keeps its sibling position (layout ledger keys are nth-child paths). */}
        {(view.attempts?.length ?? 0) >= 2 || view.attemptNote ? (
          <div className="attempt-slot">
            <AttemptTabs stageKey={view.stageKey} attempts={view.attempts} selected={view.selectedAttempt} />
            {view.attemptNote ? <div className="attempt-note">{view.attemptNote}</div> : null}
          </div>
        ) : null}
        {/* The ship preview sits ABOVE the ledger (D142, UI-R40 reading order): the first thing read before the Confirm click. */}
        {frame.preview ? <ShipPreview preview={frame.preview.data} /> : null}
        {view.processes.length ? <Ledger stageKey={view.stageKey} processes={view.processes} consoleStage={view.console ? view.stageKey : null} /> : <div className="blurb">{view.blurb}</div>}
      </section>
    </InsideScopeContext.Provider>
  );
}

export const Inside = memo(function Inside() {
  const ticket = useSlice(selectTicketStage);
  const { selection } = useSelection();
  const [memory] = useState(() => new InsideMemory());
  const stage = ticket ? shownStage(selection.selected, ticket) : null;
  return <RegionPortal id="inside">{stage ? <Block stage={stage} memory={memory} /> : null}</RegionPortal>;
});
