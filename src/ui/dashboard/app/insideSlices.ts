/**
 * The slices of the host snapshot the Inside block renders (`useSlice` needs a stable selector). The host re-sends the
 * whole snapshot every second while work runs, so the block reads two kinds of slice:
 *
 *  - the FRAME (`frameOf`): everything structural. It is compared with `sameIgnoringLive`, so a push that only
 *    advanced a clock or a token count hands back the previous object and nothing in the ledger, the evidence or
 *    the graph renders.
 *  - the LEAVES (`stageClock`, `liveDuration`, `rowField`, `timelineTokens`): the values that do tick, each read by
 *    the one small component that shows it.
 */
import type { LiveOperationView } from '../../../model/inside/progress.js';
import type { InsideProcessView, InsideStageKey, InsideStageView, TokenUsageView } from '../../../model/inside/types.js';
import type { ShipPreview } from '../../../workflow/shipPreview.js';
import type { DashboardSnapshot } from './dashboardStore.js';
import { liveOperation, overlayProcesses } from './insideLive.js';
import { STAGE_TITLE } from './railText.js';

export interface MenuFlags {
  /** Send back to Implement (the stage the host names). */
  readonly sendBack: boolean;
  /** The gate stage whose Retry the host offers, or null. */
  readonly retry: string | null;
  /** The failed gate stage whose Reset the host offers, or null. */
  readonly reset: string | null;
  readonly prFeedback: boolean;
  readonly ci: boolean;
  readonly rebase: boolean;
}

export interface Frame {
  /** The stage view with the `completed` overlay applied to its processes. */
  readonly view: InsideStageView;
  /** The current operation: the progress event, else the snapshot's own line. */
  readonly live: LiveOperationView | null;
  readonly ticketId: number;
  /** Set when the strip shows a stage that is not the ticket's current one: the title Back returns to. */
  readonly back: string | null;
  readonly menu: MenuFlags;
  readonly deliver: { readonly notOnPr: number; readonly inSandbox: number } | null;
  /** Ship only, and only while the header's ship slot waits for Confirm / Retry. */
  readonly preview: { readonly data: ShipPreview | null } | null;
}

const viewOf = (snapshot: DashboardSnapshot, stage: string): InsideStageView | undefined =>
  snapshot.state?.insideViews?.[stage as InsideStageKey];

/** The selector for one stage's frame; build it once per stage (`useMemo`). */
export const frameOf =
  (stage: string) =>
  (snapshot: DashboardSnapshot): Frame | null => {
    const state = snapshot.state;
    const view = viewOf(snapshot, stage);
    if (!state || !view) return null;
    const key = view.stageKey;
    const sb = state.sendBack;
    const rg = state.rerunGate;
    const dv = state.deliver;
    const slot = state.ship?.kind;
    return {
      view: { ...view, processes: overlayProcesses(view, snapshot.liveOps) },
      live: liveOperation(view, snapshot.liveOps),
      ticketId: state.ticketId,
      // "Not the current stage" is only meaningful when there IS one: on a ticket that never started, every stage is equally uncurrent.
      back: state.stageCurrent && stage !== state.stageCurrent ? STAGE_TITLE[state.stageCurrent] || state.stageCurrent : null,
      menu: {
        sendBack: !!(sb && sb.available && key === sb.stage),
        retry: rg && rg.available && key === rg.stage ? rg.stage : null,
        reset: state.resetStage && state.resetStage.available && key === state.resetStage.stage ? state.resetStage.stage : null,
        prFeedback: !!(state.prFeedbackFix && state.prFeedbackFix.available && key === 'ship'),
        ci: !!(state.ciFailure && state.ciFailure.available) && key === 'ship',
        rebase: !!(state.rebase && state.rebase.available) && key === (state.rebase.stage || 'ship'),
      },
      deliver: dv && dv.available && key === 'ship' ? { notOnPr: dv.notOnPr, inSandbox: dv.inSandbox } : null,
      preview: key === 'ship' && (slot === 'confirm' || slot === 'retry') ? { data: state.shipPreview ?? null } : null,
    };
  };

/** The header clock of one stage. */
export const stageClock =
  (stage: string) =>
  (snapshot: DashboardSnapshot): string => viewOf(snapshot, stage)?.clock ?? '';

/** The running operation's elapsed text. */
export const liveDuration =
  (stage: string) =>
  (snapshot: DashboardSnapshot): string | undefined => {
    const view = viewOf(snapshot, stage);
    return view ? (liveOperation(view, snapshot.liveOps)?.duration ?? undefined) : undefined;
  };

/** One process row, with the overlay applied (the row a leaf reads is the row the ledger draws). */
export const processOf = (snapshot: DashboardSnapshot, stage: string, id: string): InsideProcessView | undefined => {
  const view = viewOf(snapshot, stage);
  return view ? overlayProcesses(view, snapshot.liveOps).find((p) => p.id === id) : undefined;
};

export const rowField =
  <T>(stage: string, id: string, pick: (p: InsideProcessView) => T) =>
  (snapshot: DashboardSnapshot): T | undefined => {
    const p = processOf(snapshot, stage, id);
    return p ? pick(p) : undefined;
  };

export const pickTime = (p: InsideProcessView): string | undefined => p.time;
export const pickDuration = (p: InsideProcessView): { readonly text?: string; readonly exact?: string } => ({ text: p.duration, exact: p.durationExact });
export const pickTokens = (p: InsideProcessView): { readonly tokens?: TokenUsageView; readonly live: boolean } => ({ tokens: p.tokens, live: p.status === 'run' });

/** The token claim of one timeline row of a process's evidence, and whether that row is running. */
export const timelineTokens =
  (stage: string, id: string, index: number) =>
  (snapshot: DashboardSnapshot): { readonly tokens?: TokenUsageView; readonly live: boolean } | undefined => {
    const ev = processOf(snapshot, stage, id)?.evidence;
    const row = ev && 'rows' in ev ? ev.rows[index] : undefined;
    return row ? { tokens: row.tokens, live: row.status === 'run' } : undefined;
  };

/** Which stage the strip shows when nothing is selected: the ticket's own. Null before the first snapshot. */
export const selectTicketStage = (snapshot: DashboardSnapshot): { readonly presentedStage: string; readonly stageCurrent: string } | null => {
  const s = snapshot.state;
  return s ? { presentedStage: s.presentedStage || '', stageCurrent: s.stageCurrent || '' } : null;
};
