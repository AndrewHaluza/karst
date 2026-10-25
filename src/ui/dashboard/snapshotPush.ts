import type { DashboardState } from './state.js';
import { liveClocks, shouldLogLiveTick, structureKey, changedPaths, liveSections, type LiveLogState } from './liveTick.js';
import type { LiveTicker } from './liveTicker.js';
import type { DashboardPanel } from './panelTypes.js';
import type { SupplementalHost } from './supplementalLoaders.js';
import { buildSnapshotState, type SnapshotInputs } from './snapshotState.js';

/** Why a snapshot was pushed — debug tracing names it. */
export type PushKind = 'action' | 'passive' | 'store' | 'live' | 'follow-up';

/** What each panel was last sent, so a push can ship less. Dies with the panel. */
export class PushMemory {
  /** `structureKey` of the last FULL snapshot each panel was sent. */
  readonly sentStructure = new Map<number, string>();
  /** Debug only: the last full snapshot each panel was sent, for `changedPaths`. */
  readonly sentState = new Map<number, DashboardState>();
  /** Debug only: dedupe state for 1-second live tick logs per panel. */
  readonly liveLogState = new Map<number, LiveLogState>();
  /** The tab icon path last set on each panel, so an unchanged glyph costs no IPC. */
  readonly iconSet = new Map<number, string>();

  clear(ticketId: number): void {
    this.sentStructure.delete(ticketId);
    this.sentState.delete(ticketId);
    this.liveLogState.delete(ticketId);
    this.iconSet.delete(ticketId);
  }
}

/** `SnapshotInputs` plus the manager seams a full push needs. */
export interface SnapshotPushDeps extends SnapshotInputs {
  panelFor(ticketId: number): DashboardPanel | undefined;
  supplementalHost: SupplementalHost;
  refreshIcon(ticketId: number, panel: DashboardPanel): void;
  ticks: LiveTicker;
  memory: PushMemory;
  /** Debug sink (`[dashboard]` lines); absent or disabled → no tracing work at all. */
  debug?: { debug(msg: string): void; isDebugEnabled(): boolean };
}

/**
 * Build and post one snapshot.
 *
 * `supplemental` controls whether async filesystem facts are reloaded, `live`
 * tells the webview whether the snapshot is only a clock repaint, and
 * `settlesActions` says whether it is the host response an in-flight action
 * is waiting for. Store-backed news (such as a token delta) needs a full
 * render without restarting filesystem work or settling an unrelated action.
 *
 * The async loaders beside the state — worktree Git totals (`git` per worktree)
 * and the resolved gate names (a walk of every scoped repo) — answer
 * questions that change when the WORKTREE or the MANIFEST changes, not when
 * a gate advances a second. Re-running them on every tick would abort and
 * respawn a child process per second and never let one finish; the repaint
 * is a store read and a `postMessage`, nothing else. The tab icon is skipped
 * for the same reason: the glyph it tints changes with the ticket's status,
 * and every status change arrives on a real push.
 */
export function pushSnapshot(
  d: SnapshotPushDeps,
  ticketId: number,
  mode: { kind: PushKind; supplemental: boolean; live: boolean; settlesActions: boolean },
): void {
  const { kind, supplemental, live, settlesActions } = mode;
  const panel = d.panelFor(ticketId);
  if (!panel) return;
  const state = buildSnapshotState(d, ticketId, supplemental);
  // A key the new snapshot no longer resolved to is dropped from panel
  // memory: `selectedAttempt` reports what the builder actually rendered,
  // so a mismatch means the requested key named no attempt this round —
  // there is nothing left worth remembering for the NEXT snapshot either.
  d.selections.pruneStaleAttempts(ticketId, state);
  d.selections.pruneStaleFindingsRepos(ticketId, state);
  // `live` marks a REPAINT of data the panel already had, as opposed to a
  // push that reports something happening. The webview defers a live repaint
  // while the user is mid-interaction (an action in flight, a text selection
  // being made) — a snapshot pushed once a second must never redraw over
  // what someone is doing, and only the sender knows which kind it is.
  // A repaint whose snapshot differs from the last one sent only in its
  // clocks ships just the clocks: the webview's live repaint writes clock
  // text and nothing else, and over Remote-SSH the full snapshot (100 KB+)
  // once a second is what made the panel crawl. New structure — a row that
  // opened, a status that moved — still ships the whole snapshot.
  // The same holds for a passive push (a CLI or usage write re-pushing every
  // open panel) that turned up nothing new. Only a push that settles an
  // action always ships whole: the webview clears its pending action on it.
  // A loader follow-up that changed nothing visible is clocks too, even when
  // it carries settlement authority: the snapshot it follows already settled.
  const structure = structureKey(state);
  const unchanged = d.memory.sentStructure.get(ticketId) === structure;
  const clocksOnly = unchanged && (!settlesActions || kind === 'follow-up');
  tracePush(d, ticketId, kind, clocksOnly, state);
  if (clocksOnly) {
    panel.postMessage({ type: 'clocks', clocks: liveClocks(state) });
  } else {
    d.memory.sentStructure.set(ticketId, structure);
    panel.postMessage({
      type: 'state',
      state,
      ...(live ? { live: true } : {}),
      ...(!supplemental && !live ? { supplemental: false } : {}),
      ...(!settlesActions ? { settlesActions: false } : {}),
    });
  }
  // Every real push may carry a status change (a hook flips needs-you amber),
  // so the tab glyph follows it; a live tick only moves clocks.
  if (!live) d.refreshIcon(ticketId, panel);
  if (supplemental) {
    d.loaders.pushWorktreeStats(ticketId, panel, state.worktrees, d.supplementalHost);
    d.loaders.prefetchBranchCandidates(ticketId, panel, state.worktrees, d.supplementalHost);
    d.loaders.pushGateOptions(ticketId, panel, settlesActions, d.supplementalHost);
    d.loaders.pushBaselines(ticketId, panel, settlesActions, d.supplementalHost);
    d.loaders.pushStoredArtifacts(ticketId, panel, settlesActions, d.supplementalHost);
    // The preview is read only while ship waits for its Confirm click (D142):
    // entering the confirm/retry slot — on open or on a real push — is what
    // triggers the read. A live repaint never does.
    if (state.ship.kind === 'confirm' || state.ship.kind === 'retry') {
      d.loaders.pushShipPreview(ticketId, panel, settlesActions, d.supplementalHost);
    }
  }
  d.ticks.schedule(ticketId, state);
}

/**
 * Debug only: one line per push naming its kind, whether it shipped whole,
 * which fields changed since the last full snapshot, and the caller frame —
 * enough to trace an unexplained stream of full snapshots to its source.
 */
function tracePush(
  d: SnapshotPushDeps,
  ticketId: number,
  kind: PushKind,
  clocksOnly: boolean,
  state: DashboardState,
): void {
  if (!d.debug?.isDebugEnabled()) return;
  const prev = d.memory.sentState.get(ticketId);
  if (!clocksOnly) d.memory.sentState.set(ticketId, state);
  const changed = clocksOnly ? '' : `; changed: ${prev ? changedPaths(prev, state).slice(0, 8).join(', ') || 'none' : 'first'}`;
  if (kind === 'live') {
    const reason = clocksOnly ? 'clocks' : `state${changed}`;
    const sections = liveSections(state);
    const logState = d.memory.liveLogState.get(ticketId);
    const { shouldLog, next } = shouldLogLiveTick(logState, Date.now(), reason, sections);
    if (!shouldLog) return;
    d.memory.liveLogState.set(ticketId, next);
  }
  const caller = new Error().stack?.split('\n')[4]?.trim() ?? '?';
  d.debug.debug(`[dashboard] ticket ${ticketId} push ${kind} → ${clocksOnly ? 'clocks' : 'state'}${changed} from ${caller}`);
}
