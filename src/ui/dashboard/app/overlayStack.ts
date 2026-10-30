/**
 * Which overlay the dashboard shows on top of the ticket, and the one Escape chain over them (migration Phase 11).
 *
 * The overlays are local view state, never part of `DashboardState` and never round-tripped: the ticket-data
 * drawer, the stage menu (owned by Inside, which only says whether it is open), the console, the server logs, the
 * env-override editor and the artifact view (index, stored, detail). The page's ordered Escape chain is
 * drawer, stage menu, console, logs, env, artifact view; `escape()` is the ONE owner of that order.
 *
 * Artifact navigation keeps a scroll position per surface (spec §9): saved on leaving a surface, restored on
 * returning, one entry per artifact id for details. Each navigation is handed to `persistArt` (`ViewPersistence`
 * writes it with the rest of the view state); the initial view and scrolls are read once from the persisted view
 * state (`restoreArt`).
 */
import { formatId } from '../../../model/entityId.js';
import type { HostMessage } from '../messages.js';
import type { DashboardState } from '../state.js';
import type { DashboardSender } from './hostBridge.js';
import { initialXtermState, runXtermBundle, settledXtermState, type XtermState } from './xtermLoader.js';

/** null = the ticket dashboard; a detail remembers where Back answers (the ticket, or the index it came from). */
export type ArtView = 'index' | 'stored' | { readonly id: string; readonly from: 'index' | 'ticket' };

export interface ArtScrolls {
  ticket: number;
  index: number;
  detail: Record<string, number>;
}

/** What is persisted beside the snapshot: the artifact surface (null = the ticket) and each surface's scroll. */
export interface PersistArt {
  readonly artView: ArtView | null;
  readonly artScrolls: ArtScrolls;
  /** The views Back walks through, oldest first; the current view is not in it. */
  readonly history: readonly OverlayView[];
}

export interface ConsoleTarget {
  readonly stage: string;
  /** The gate-lane AI process whose console is open; null = the stage's own console. */
  readonly processId: string | null;
}

/** One drill-down view (all null/false = the ticket dashboard). Surfaces are mutually exclusive. */
export interface OverlayView {
  readonly console: ConsoleTarget | null;
  readonly logs: boolean;
  readonly env: boolean;
  readonly art: ArtView | null;
}

export interface OverlaySnapshot {
  /** The ticket-data drawer: the text composed when it opened (the drawer never refreshes it). */
  readonly drawer: { readonly text: string } | null;
  readonly stageMenu: boolean;
  readonly console: ConsoleTarget | null;
  readonly logs: boolean;
  readonly env: boolean;
  readonly art: ArtView | null;
  /** A view-pill menu (console streams) is open; Escape closes it before leaving the surface. */
  readonly pillMenu: boolean;
  /** The views Back walks through, oldest first (the dashboard is `DASHBOARD`). */
  readonly history: readonly OverlayView[];
  readonly xterm: XtermState;
}

export interface ScrollPort {
  read(): number;
  write(top: number): void;
}

export interface OverlayDeps {
  readonly send: Pick<DashboardSender, 'xtermRequest' | 'stageLogRequest' | 'agentLogRequest'>;
  readonly getState: () => DashboardState | null;
  readonly scroll: ScrollPort;
  readonly persistArt: (detail: PersistArt) => void;
  readonly restored: { readonly art: ArtView | null; readonly scrolls: ArtScrolls; readonly history?: readonly OverlayView[] };
  /** False when a history entry's target is gone (artifact deleted, server removed); Back skips it. */
  readonly exists?: (view: OverlayView) => boolean;
}

export const DASHBOARD: OverlayView = { console: null, logs: false, env: false, art: null };

/** The drawer's body: the fetched brief verbatim, else the ticket's own heading and prompt (a manual ticket has no brief). */
export function ticketDataText(state: DashboardState): string {
  const brief = (state.brief || '').trim();
  if (brief) return brief;
  const heading = [state.key || formatId('ticket', state.ticketId), state.title].filter((v) => v).join(' — ');
  const lines = [`# ${heading}`];
  const prompt = (state.description || '').trim();
  if (prompt) lines.push('', prompt);
  return lines.join('\n');
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
const finite = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** The persisted artifact view and scroll memory, tolerant of a state saved by an older build (which has neither). */
function restoreView(raw: unknown): OverlayView | null {
  if (!isRecord(raw)) return null;
  const c = raw.console;
  const console = isRecord(c) && typeof c.stage === 'string' && c.stage ? { stage: c.stage, processId: typeof c.processId === 'string' && c.processId ? c.processId : null } : null;
  const v = raw.art;
  const art: ArtView | null =
    v === 'index' || v === 'stored' ? v : isRecord(v) && typeof v.id === 'string' && v.id ? { id: v.id, from: v.from === 'index' ? 'index' : 'ticket' } : null;
  return { console, logs: raw.logs === true, env: raw.env === true, art };
}

/** The persisted artifact view and scroll memory, tolerant of a state saved by an older build (which has neither). */
export function restoreArt(raw: unknown): { art: ArtView | null; scrolls: ArtScrolls; history: OverlayView[] } {
  const view = isRecord(raw) ? raw : {};
  const v = view.artView;
  const art: ArtView | null =
    v === 'index' || v === 'stored' ? v : isRecord(v) && typeof v.id === 'string' && v.id ? { id: v.id, from: v.from === 'index' ? 'index' : 'ticket' } : null;
  const s = isRecord(view.artScrolls) ? view.artScrolls : {};
  const detail: Record<string, number> = {};
  if (isRecord(s.detail)) for (const [id, top] of Object.entries(s.detail)) detail[id] = finite(top);
  const history = Array.isArray(view.history) ? view.history.map(restoreView).filter((e): e is OverlayView => e !== null) : [];
  return { art, scrolls: { ticket: finite(s.ticket), index: finite(s.index), detail }, history };
}

const listsStage = (v: ArtView | null): v is 'index' | 'stored' => v === 'index' || v === 'stored';

export class OverlayStack {
  private snapshot: OverlaySnapshot;
  private readonly scrolls: ArtScrolls;
  private trigger: Element | null = null;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly deps: OverlayDeps) {
    this.scrolls = { ...deps.restored.scrolls, detail: { ...deps.restored.scrolls.detail } };
    this.snapshot = { drawer: null, stageMenu: false, console: null, logs: false, env: false, art: deps.restored.art, pillMenu: false, history: deps.restored.history ?? [], xterm: initialXtermState() };
  }

  readonly getSnapshot = (): OverlaySnapshot => this.snapshot;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** Host messages the stack itself answers: the lazily delivered xterm bundle, which must land even if the console has closed again. */
  receive(message: HostMessage): void {
    if (message.type !== 'xterm') return;
    if (typeof message.js === 'string' && message.js) runXtermBundle(message.js);
    this.set({ xterm: settledXtermState() });
  }

  // ---- the ticket-data drawer: a pure page surface, it posts nothing ----

  readonly openTicketData = (): void => {
    const state = this.deps.getState();
    if (!state) return;
    this.trigger = document.activeElement;
    this.set({ drawer: { text: ticketDataText(state) } });
  };

  readonly closeTicketData = (): void => {
    const trigger = this.trigger;
    this.trigger = null;
    this.set({ drawer: null });
    if (trigger && 'focus' in trigger) (trigger as HTMLElement).focus();
  };

  // ---- the Inside stage menu: React-owned, it only says whether it is open so Escape yields to it ----

  readonly setStageMenuOpen = (open: boolean): void => this.set({ stageMenu: open });

  // ---- the console (xterm) ----

  /** Opens the console and asks the host for its log (and, once, for the xterm bundle); the host's answer is the outcome (UI-R13). */
  readonly openConsole = (stage: string, processId: string | null): void => {
    const open = this.snapshot.console;
    if (open && open.stage === stage && open.processId === processId) return;
    const asksForXterm = this.snapshot.xterm === 'absent';
    this.enter({ ...DASHBOARD, console: { stage, processId } }, asksForXterm ? { xterm: 'loading' } : {});
    if (asksForXterm) this.deps.send.xtermRequest();
    if (processId) this.deps.send.agentLogRequest(processId as Parameters<typeof this.deps.send.agentLogRequest>[0]);
    else this.deps.send.stageLogRequest(stage as Parameters<typeof this.deps.send.stageLogRequest>[0]);
  };

  readonly closeConsole = (): void => {
    if (this.snapshot.console) this.back();
  };

  // ---- the combined server logs (the shared runtime draws it) and the env-override editor ----

  readonly openLogs = (): void => {
    if (this.snapshot.logs || typeof (globalThis as { createServerLogsView?: unknown }).createServerLogsView !== 'function') return;
    this.enter({ ...DASHBOARD, logs: true });
  };

  readonly closeLogs = (): void => {
    if (this.snapshot.logs) this.back();
  };

  readonly openEnv = (): void => {
    if (!this.snapshot.env) this.enter({ ...DASHBOARD, env: true });
  };

  readonly closeEnv = (): void => {
    if (this.snapshot.env) this.back();
  };

  /** Opens any view (a pill, a crumb): pushes the view it leaves, like every other navigation. */
  readonly goTo = (view: OverlayView): void => this.enter(view);

  /** A view-pill menu says whether it is open so Escape closes it first. */
  readonly setPillMenuOpen = (open: boolean): void => this.set({ pillMenu: open });

  // ---- the artifact view ----

  readonly openIndex = (): void => this.navigate('index');

  readonly openStored = (): void => this.navigate('stored');

  /** A detail opened from the index returns to it; from anywhere else it returns to the ticket (spec §7.3). */
  readonly openArtifact = (id: string): void => this.navigate({ id, from: this.snapshot.art === 'index' ? 'index' : 'ticket' });

  /** Back pops the history to the previous view, skipping entries whose target is gone; an empty history answers the dashboard. */
  readonly back = (): void => {
    const { history } = this.snapshot;
    const exists = this.deps.exists ?? (() => true);
    let i = history.length;
    while (i > 0 && !exists(history[i - 1]!)) i--;
    const target = i > 0 ? history[i - 1]! : DASHBOARD;
    this.saveScroll();
    this.set({ ...target, history: history.slice(0, Math.max(i - 1, 0)) });
    this.announce();
  };

  private currentView(): OverlayView {
    const { console, logs, env, art } = this.snapshot;
    return { console, logs, env, art };
  }

  /** Every navigation pushes the view it leaves; re-entering the view already showing is a no-op. */
  private enter(view: OverlayView, extra: Partial<OverlaySnapshot> = {}): void {
    const cur = this.currentView();
    if (cur.console === view.console && cur.logs === view.logs && cur.env === view.env && cur.art === view.art) return;
    this.saveScroll();
    this.set({ ...view, ...extra, history: [...this.snapshot.history, cur] });
    this.announce();
  }

  /** A restored detail whose artifact has since vanished (the evidence was deleted) shows the index instead. */
  readonly fallbackToIndex = (): void => {
    this.set({ art: 'index' });
    this.announce();
  };

  /** Puts the document where the surface now showing was left; the view calls it once that surface is on screen. */
  readonly restoreScroll = (): void => {
    const art = this.snapshot.art;
    const top = !art ? this.scrolls.ticket : listsStage(art) ? this.scrolls.index : (this.scrolls.detail[art.id] ?? 0);
    this.deps.scroll.write(top);
  };

  /** The ONE Escape chain; true when it closed something. The stage menu closes itself, so the chain stops at its place. */
  readonly escape = (): boolean => {
    const s = this.snapshot;
    if (s.drawer) this.closeTicketData();
    else if (s.stageMenu) return false;
    else if (s.pillMenu) this.setPillMenuOpen(false);
    else if (s.console || s.logs || s.env || s.art) this.back();
    else return false;
    return true;
  };

  private navigate(next: ArtView | null): void {
    this.enter({ ...DASHBOARD, art: next });
  }

  private saveScroll(): void {
    const art = this.snapshot.art;
    const top = this.deps.scroll.read();
    if (!art) this.scrolls.ticket = top;
    else if (listsStage(art)) this.scrolls.index = top;
    else this.scrolls.detail[art.id] = top;
  }

  private announce(): void {
    this.deps.persistArt({
      artView: this.snapshot.art,
      artScrolls: { ...this.scrolls, detail: { ...this.scrolls.detail } },
      history: this.snapshot.history,
    });
  }

  private set(change: Partial<OverlaySnapshot>): void {
    const next = { ...this.snapshot, ...change };
    if ((Object.keys(change) as Array<keyof OverlaySnapshot>).every((key) => Object.is(next[key], this.snapshot[key]))) return;
    this.snapshot = next;
    for (const listener of [...this.listeners]) listener();
  }
}
