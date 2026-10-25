/**
 * Which overlay the dashboard shows on top of the ticket, and the one Escape chain over them (migration Phase 11).
 *
 * The overlays are local view state, never part of `DashboardState` and never round-tripped: the ticket-data
 * drawer, the stage menu (owned by Inside, which only says whether it is open), the console, the server logs, the
 * env-override editor and the artifact view (index, stored, detail). The page's ordered Escape chain is
 * drawer, stage menu, console, logs, env, artifact view; `escape()` is the ONE owner of that order.
 *
 * Artifact navigation keeps a scroll position per surface (spec §9): saved on leaving a surface, restored on
 * returning, one entry per artifact id for details. React never writes `vscode.setState` (A3): each navigation is
 * announced one way (`artSeam.ts`) and the page persists it; the initial view and scrolls are read once from the
 * persisted view state (`restoreArt`).
 */
import type { HostMessage } from '../messages.js';
import type { DashboardState } from '../state.js';
import type { DashboardSender } from './hostBridge.js';
import type { PersistArt } from './artSeam.js';
import { initialXtermState, runXtermBundle, settledXtermState, type XtermState } from './xtermLoader.js';

/** null = the ticket dashboard; a detail remembers where Back answers (the ticket, or the index it came from). */
export type ArtView = 'index' | 'stored' | { readonly id: string; readonly from: 'index' | 'ticket' };

export interface ArtScrolls {
  ticket: number;
  index: number;
  detail: Record<string, number>;
}

export interface ConsoleTarget {
  readonly stage: string;
  /** The gate-lane AI process whose console is open; null = the stage's own console. */
  readonly processId: string | null;
}

export interface OverlaySnapshot {
  /** The ticket-data drawer: the text composed when it opened (the drawer never refreshes it). */
  readonly drawer: { readonly text: string } | null;
  readonly stageMenu: boolean;
  readonly console: ConsoleTarget | null;
  readonly logs: boolean;
  readonly env: boolean;
  readonly art: ArtView | null;
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
  readonly restored: { readonly art: ArtView | null; readonly scrolls: ArtScrolls };
}

/** The drawer's body: the fetched brief verbatim, else the ticket's own heading and prompt (a manual ticket has no brief). */
export function ticketDataText(state: DashboardState): string {
  const brief = (state.brief || '').trim();
  if (brief) return brief;
  const heading = [state.key || `#${state.ticketId}`, state.title].filter((v) => v).join(' — ');
  const lines = [`# ${heading}`];
  const prompt = (state.description || '').trim();
  if (prompt) lines.push('', prompt);
  return lines.join('\n');
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
const finite = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** The persisted artifact view and scroll memory, tolerant of a state saved by an older build (which has neither). */
export function restoreArt(raw: unknown): { art: ArtView | null; scrolls: ArtScrolls } {
  const view = isRecord(raw) ? raw : {};
  const v = view.artView;
  const art: ArtView | null =
    v === 'index' || v === 'stored' ? v : isRecord(v) && typeof v.id === 'string' && v.id ? { id: v.id, from: v.from === 'index' ? 'index' : 'ticket' } : null;
  const s = isRecord(view.artScrolls) ? view.artScrolls : {};
  const detail: Record<string, number> = {};
  if (isRecord(s.detail)) for (const [id, top] of Object.entries(s.detail)) detail[id] = finite(top);
  return { art, scrolls: { ticket: finite(s.ticket), index: finite(s.index), detail } };
}

const listsStage = (v: ArtView | null): v is 'index' | 'stored' => v === 'index' || v === 'stored';

export class OverlayStack {
  private snapshot: OverlaySnapshot;
  private readonly scrolls: ArtScrolls;
  private trigger: Element | null = null;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly deps: OverlayDeps) {
    this.scrolls = { ...deps.restored.scrolls, detail: { ...deps.restored.scrolls.detail } };
    this.snapshot = { drawer: null, stageMenu: false, console: null, logs: false, env: false, art: deps.restored.art, xterm: initialXtermState() };
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
    this.set(asksForXterm ? { console: { stage, processId }, xterm: 'loading' } : { console: { stage, processId } });
    if (asksForXterm) this.deps.send.xtermRequest();
    if (processId) this.deps.send.agentLogRequest(processId as Parameters<typeof this.deps.send.agentLogRequest>[0]);
    else this.deps.send.stageLogRequest(stage as Parameters<typeof this.deps.send.stageLogRequest>[0]);
  };

  readonly closeConsole = (): void => this.set({ console: null });

  // ---- the combined server logs (the shared runtime draws it) and the env-override editor ----

  readonly openLogs = (): void => {
    if (this.snapshot.logs || typeof (globalThis as { createServerLogsView?: unknown }).createServerLogsView !== 'function') return;
    this.set({ logs: true });
  };

  readonly closeLogs = (): void => this.set({ logs: false });

  readonly openEnv = (): void => this.set({ env: true });

  readonly closeEnv = (): void => this.set({ env: false });

  // ---- the artifact view ----

  readonly openIndex = (): void => this.navigate('index');

  readonly openStored = (): void => this.navigate('stored');

  /** A detail opened from the index returns to it; from anywhere else it returns to the ticket (spec §7.3). */
  readonly openArtifact = (id: string): void => this.navigate({ id, from: this.snapshot.art === 'index' ? 'index' : 'ticket' });

  /** Back is deterministic: detail to its origin, index and stored to the ticket. */
  readonly back = (): void => {
    const art = this.snapshot.art;
    if (!art) return;
    this.navigate(listsStage(art) ? null : art.from === 'index' ? 'index' : null);
  };

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
    else if (s.console) this.closeConsole();
    else if (s.logs) this.closeLogs();
    else if (s.env) this.closeEnv();
    else if (s.art) this.back();
    else return false;
    return true;
  };

  private navigate(next: ArtView | null): void {
    this.saveScroll();
    this.set({ art: next });
    this.announce();
  }

  private saveScroll(): void {
    const art = this.snapshot.art;
    const top = this.deps.scroll.read();
    if (!art) this.scrolls.ticket = top;
    else if (listsStage(art)) this.scrolls.index = top;
    else this.scrolls.detail[art.id] = top;
  }

  private announce(): void {
    this.deps.persistArt({ artView: this.snapshot.art, artScrolls: { ...this.scrolls, detail: { ...this.scrolls.detail } } });
  }

  private set(change: Partial<OverlaySnapshot>): void {
    const next = { ...this.snapshot, ...change };
    if ((Object.keys(change) as Array<keyof OverlaySnapshot>).every((key) => Object.is(next[key], this.snapshot[key]))) return;
    this.snapshot = next;
    for (const listener of [...this.listeners]) listener();
  }
}
