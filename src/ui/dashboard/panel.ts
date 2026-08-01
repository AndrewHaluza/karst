import type { Store } from '../../store/db.js';
import type { AgentProvider } from '../../manifest/types.js';
import { getTicket, ticketLabel } from '../../store/tickets.js';
import type { TicketProvider } from '../../manifest/types.js';
import type { LogError } from '../../logging/logger.js';
import type { ShipStepEvent } from '../../workflow/stages/ship.js';
import {
  buildDashboardState,
  type DashboardAgentContext,
  type DashboardState,
  type PathContext,
} from './state.js';
import { routeAction, type DashboardActions } from './messages.js';
import type { WorktreeStatsLoader } from './worktreeStats.js';

/**
 * The subset of a `vscode.WebviewPanel` the manager touches. Modeling it as an
 * interface keeps `DashboardManager` host-agnostic and unit-testable without a
 * `vscode` module; the activation adapter supplies a real panel.
 */
export interface DashboardPanel {
  /**
   * Bring the panel forward. `preserveFocus` leaves the keyboard where it is
   * (real: `panel.reveal(column, preserveFocus)`) — what the terminal binding
   * needs, and what keeps a bound reveal from re-activating the panel and
   * bouncing the focus straight back.
   */
  reveal(preserveFocus?: boolean): void;
  postMessage(message: unknown): void;
  onDidReceiveMessage(handler: (message: unknown) => void): void;
  /**
   * The panel gained or lost activation (real: `onDidChangeViewState`, reading
   * `e.webviewPanel.active`). `active` is true only when the user is actually
   * on this panel — a preserve-focus reveal makes it visible, not active.
   */
  onDidChangeViewState(handler: (active: boolean) => void): void;
  onDidDispose(handler: () => void): void;
  /** Update the tab icon (real: `panel.iconPath = Uri.file(path)`). */
  setIcon(path: string): void;
}

/** Factory the manager uses to mint panels (real: `createWebviewPanel`). */
export interface PanelHost {
  createPanel(title: string, ticketId: number, preserveFocus?: boolean): DashboardPanel;
}

/** Test double surface — extends the panel with recorded state + an emitter. */
export interface FakePanel extends DashboardPanel {
  title: string;
  revealed: number;
  /** The `preserveFocus` the panel was CREATED with, if any. */
  createdPreserveFocus?: boolean;
  /** The `preserveFocus` argument of every `reveal`, in order. */
  revealedPreserveFocus: Array<boolean | undefined>;
  disposed: boolean;
  posted: unknown[];
  /** Every `setIcon` path, in order — the live-tint assertion surface. */
  icons: string[];
  messageHandlers: Array<(m: unknown) => void>;
  viewStateHandlers: Array<(active: boolean) => void>;
  disposeHandler?: () => void;
  dispose(): void;
  emit(message: unknown): void;
  emitViewState(active: boolean): void;
}

/**
 * The window's terminal↔dashboard binding, injected so the manager needs no
 * knowledge of the binder itself. `enabled` is read live (it flips at runtime);
 * `onDidActivate` reports raw panel activation — including LOSING it — and
 * leaves the interpretation to the binder.
 */
export interface DashboardBinding {
  enabled(): boolean;
  onDidActivate(ticketId: number, active: boolean): void;
}

/** Resolve the daemon actions for a ticket (lets the host bind live services). */
export type ActionsFactory = (ticketId: number) => DashboardActions;

/**
 * One dashboard panel per ticket id (§14). `openDashboard` reveals an existing
 * panel rather than spawning a duplicate; disposal drops the panel so a later
 * open recreates it. State is pushed to the webview via `postMessage`.
 */
export class DashboardManager {
  private readonly panels = new Map<number, DashboardPanel>();
  private readonly statsRequests = new Map<number, number>();
  private readonly statsControllers = new Map<number, AbortController>();

  /**
   * `pathContext` is a getter (optional) so worktree paths render per the current
   * manifest's `worktreePathDisplay` + workspace root. Absent → absolute paths.
   */
  constructor(
    private readonly store: Store,
    private readonly host: PanelHost,
    private readonly actionsFor: ActionsFactory,
    private readonly pathContext?: () => PathContext | undefined,
    /** Live ticket-label template getter (honors manifest `ticketLabelTemplate`). */
    private readonly labelTemplate?: () => string | undefined,
    /**
     * Live ticketing config getter (honors manifest `ticketing.provider`) so the
     * dashboard can render a link to the source board (§ C3). Absent → no link.
     */
    private readonly ticketing?: () => { provider?: TicketProvider } | undefined,
    /** Report a caught pump error to the Karst output channel (§ todo-5). */
    private readonly logError: LogError = (m, e) => console.error(m, e),
    /**
     * Resolve an approach id → its workflow phase names, for the read-only
     * impl-stage breakdown (§ impl sub-stages). Absent → no breakdown shown.
     */
    private readonly approachPhases?: (approachId: string | null) => string[],
    /**
     * Resolve a ticket → the file path of its status-tinted tab icon. Called on
     * open AND on every state push, so the tab color tracks the live glyph.
     * Absent → the tab keeps the editor's default icon.
     */
    private readonly iconFor?: (ticketId: number) => string | undefined,
    /**
     * Whether a scoped repository declares a runnable service (manifest-backed,
     * injected so this module stays manifest-free). Absent → assume runnable, so
     * a window with no resolved manifest behaves as it did before.
     */
    private readonly isRepoRunnable?: (repo: string) => boolean,
    /** Live manifest agent core, so the session verb previews the real launch. */
    private readonly defaultProvider?: () => AgentProvider | undefined,
    /**
     * The window's terminal binding. Absent → the toggle renders off and panel
     * activation is not reported, which is exactly the pre-binding behavior.
     */
    private readonly binding?: DashboardBinding,
    /** Live session/model context for the dashboard's agent switch affordance. */
    private readonly agentContext?: () => DashboardAgentContext,
    /** Live Git totals, delivered separately from the synchronous store state. */
    private readonly loadStats?: WorktreeStatsLoader,
  ) {}

  /**
   * Open (or reveal) the dashboard for a ticket and push its initial state.
   * `preserveFocus` is for the terminal binding: the panel comes forward beside
   * the terminal the user clicked, without stealing the caret out of it.
   */
  openDashboard(ticketId: number, opts?: { preserveFocus?: boolean }): void {
    const existing = this.panels.get(ticketId);
    if (existing) {
      existing.reveal(opts?.preserveFocus);
      return;
    }

    const panel = this.host.createPanel(
      ticketLabel(getTicket(this.store, ticketId), this.labelTemplate?.()),
      ticketId,
      opts?.preserveFocus,
    );
    this.panels.set(ticketId, panel);

    const actions = this.actionsFor(ticketId);
    // Message pump must never die on one bad message — routeAction validates,
    // and any downstream throw is contained so subsequent messages still flow.
    panel.onDidReceiveMessage((raw) => {
      try {
        routeAction(raw, actions);
      } catch (err) {
        this.logError('karst: dashboard action failed', err);
      }
    });
    panel.onDidChangeViewState((active) => this.binding?.onDidActivate(ticketId, active));
    panel.onDidDispose(() => {
      if (this.panels.get(ticketId) !== panel) return;
      this.statsControllers.get(ticketId)?.abort();
      this.panels.delete(ticketId);
      this.statsRequests.delete(ticketId);
      this.statsControllers.delete(ticketId);
    });

    this.refreshIcon(ticketId, panel);
    this.pushState(ticketId);
    this.postBind(panel);
  }

  /**
   * Push the binding state to EVERY open panel. The preference is window-wide,
   * so a toggle on one dashboard must not leave the others rendering the old
   * value — and it is host-owned, so it cannot ride on `DashboardState`, which
   * `buildDashboardState` rebuilds from the store.
   */
  pushBind(): void {
    for (const panel of this.panels.values()) this.postBind(panel);
  }

  private postBind(panel: DashboardPanel): void {
    panel.postMessage({ type: 'bind', enabled: this.binding?.enabled() ?? false });
  }

  /** Push a fresh state snapshot to a ticket panel; no-op if not open. */
  pushState(ticketId: number): void {
    const panel = this.panels.get(ticketId);
    if (!panel) return;
    const state = buildDashboardState(
      this.store,
      ticketId,
      this.pathContext?.(),
      this.ticketing?.(),
      this.approachPhases,
      this.isRepoRunnable,
      this.defaultProvider?.(),
      this.agentContext?.(),
    );
    panel.postMessage({ type: 'state', state });
    this.pushWorktreeStats(ticketId, panel, state.worktrees);
    this.refreshIcon(ticketId, panel);
  }

  /**
   * Load supplemental filesystem facts without making the store-backed state
   * builder async. Only the latest request for the still-live panel may post.
   */
  private pushWorktreeStats(
    ticketId: number,
    panel: DashboardPanel,
    worktrees: DashboardState['worktrees'],
  ): void {
    if (!this.loadStats) return;
    this.statsControllers.get(ticketId)?.abort();
    const controller = new AbortController();
    this.statsControllers.set(ticketId, controller);
    const request = (this.statsRequests.get(ticketId) ?? 0) + 1;
    this.statsRequests.set(ticketId, request);
    void this.loadStats(worktrees, controller.signal).then(
      (stats) => {
        if (this.panels.get(ticketId) !== panel) return;
        if (this.statsRequests.get(ticketId) !== request) return;
        this.statsControllers.delete(ticketId);
        panel.postMessage({ type: 'worktree-stats', stats });
      },
      (error) => {
        if (this.panels.get(ticketId) !== panel) return;
        if (this.statsRequests.get(ticketId) !== request) return;
        this.statsControllers.delete(ticketId);
        this.logError('karst: dashboard worktree stats failed', error);
      },
    );
  }

  /**
   * Push a transient ship-progress event to a ticket panel; no-op if not open.
   *
   * Separate from `pushState` on purpose: the ship stage's live per-step state
   * is not in the store — `buildDashboardState` cannot re-derive it — so it
   * rides its own ephemeral message that the webview overlays on the Inside
   * block while a ship is in flight, then discards on the next real state push.
   */
  postShipProgress(ticketId: number, event: ShipStepEvent): void {
    const panel = this.panels.get(ticketId);
    if (!panel) return;
    panel.postMessage({ type: 'ship-progress', event });
  }

  /**
   * Push fresh state to every open panel. Used by background sweeps (e.g. PR
   * status sync) whose result may touch any open ticket, so the caller need not
   * track which ticket changed.
   */
  pushAll(): void {
    for (const ticketId of this.panels.keys()) this.pushState(ticketId);
  }

  /** Re-point the tab icon at the ticket's current status glyph. */
  private refreshIcon(ticketId: number, panel: DashboardPanel): void {
    const icon = this.iconFor?.(ticketId);
    if (icon) panel.setIcon(icon);
  }

  /** Whether a panel is currently open for a ticket (for the caller/tests). */
  isOpen(ticketId: number): boolean {
    return this.panels.has(ticketId);
  }
}
