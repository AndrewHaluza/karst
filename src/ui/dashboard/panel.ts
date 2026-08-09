import type { Store } from '../../store/db.js';
import type { AgentProvider } from '../../manifest/types.js';
import { getTicket, ticketLabel } from '../../store/tickets.js';
import type { TicketProvider } from '../../manifest/types.js';
import type { LogError } from '../../logging/logger.js';
import type { GateStageKey } from '../../workflow/fixAttempts.js';
import { existsSync, realpathSync } from 'node:fs';
import type { InsideProgressEvent } from '../../model/inside/progress.js';
import { listWorktreesByTicket } from '../../store/dashboard.js';
import {
  InsideActionRegistry,
  dispatchInsideAction,
  type InsideActionHost,
} from './insideActions.js';
import {
  buildDashboardState,
  type DashboardAgentContext,
  type DashboardState,
  type PathContext,
} from './state.js';
import { parseInsideProgress, parseWebviewMessage, routeAction, type DashboardActions } from './messages.js';
import type { WorktreeStatsLoader } from './worktreeStats.js';
import type { GateOptionsLoader } from './gateOptions.js';
import { readRequestId, reportAction } from '../../model/actionResult.js';

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
  private readonly gateRequests = new Map<number, number>();
  private readonly gateControllers = new Map<number, AbortController>();
  /** The CURRENT snapshot-scoped action registry per ticket (host-only targets). */
  private readonly registries = new Map<number, InsideActionRegistry>();
  private readonly generations = new Map<number, number>();

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
    /**
     * The fix budget for one gate, from the live manifest, so the rail's retry
     * meter draws the number of attempts the driver will actually spend.
     * Optional: an unresolved manifest degrades to the graph's own cap rather
     * than to a number that would misreport how many retries remain.
     */
    private readonly fixCapFor?: (gate: GateStageKey) => number,
    /**
     * Resolve this ticket's togglable gate names. Async and filesystem-touching,
     * so it rides its own message rather than `DashboardState` — the same split
     * `loadStats` uses, for the same reason. Absent → the Gates section stays
     * empty, which is exactly the pre-feature panel.
     */
    private readonly loadGateOptions?: GateOptionsLoader,
    /**
     * The host implementations of the inside actions (open a file, open a PR
     * URL, resume a stage…), bound in the extension host. Absent → actions
     * resolve to unknown/rejected but never dispatch — a no-op host.
     */
    private readonly insideHost?: InsideActionHost,
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
      // Read the correlation id off the RAW message, before it is narrowed —
      // `parseWebviewMessage` deliberately drops fields it does not model, and
      // that dropping is the trust boundary (see readRequestId's own doc).
      const requestId = readRequestId(raw);
      // An unparsed message posts NOTHING (UI-R13): no action ran, so there is
      // no terminal outcome to report, and reporting one anyway would ack a
      // message the host never acted on.
      if (!parseWebviewMessage(raw)) return;
      void reportAction(requestId, (message) => panel.postMessage(message), () => {
        try {
          const result = routeAction(raw, actions);
          if (result && typeof (result as PromiseLike<void>).then === 'function') {
            return (result as Promise<void>).catch((err: unknown) => {
              this.logError('karst: dashboard action failed', err);
              throw err;
            });
          }
          return result;
        } catch (err) {
          this.logError('karst: dashboard action failed', err);
          throw err;
        }
      });
    });
    panel.onDidChangeViewState((active) => this.binding?.onDidActivate(ticketId, active));
    panel.onDidDispose(() => {
      if (this.panels.get(ticketId) !== panel) return;
      this.statsControllers.get(ticketId)?.abort();
      this.gateControllers.get(ticketId)?.abort();
      this.panels.delete(ticketId);
      this.statsRequests.delete(ticketId);
      this.statsControllers.delete(ticketId);
      this.gateRequests.delete(ticketId);
      this.gateControllers.delete(ticketId);
      // The panel's action capabilities die with it: a disposed panel's ids
      // must never dispatch against a later snapshot.
      this.registries.get(ticketId)?.dispose();
      this.registries.delete(ticketId);
      this.generations.delete(ticketId);
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
    // A fresh action registry PER SNAPSHOT: every state push is authoritative,
    // so the ids it mints are the only live capabilities. The registry itself
    // (with its host-only targets) never leaves this manager.
    const generation = (this.generations.get(ticketId) ?? 0) + 1;
    this.generations.set(ticketId, generation);
    const registry = new InsideActionRegistry(generation, ticketId);
    this.registries.get(ticketId)?.dispose();
    this.registries.set(ticketId, registry);
    const state = buildDashboardState(
      this.store,
      ticketId,
      this.pathContext?.(),
      this.ticketing?.(),
      this.approachPhases,
      this.isRepoRunnable,
      this.defaultProvider?.(),
      this.agentContext?.(),
      this.fixCapFor,
      () => [],
      () => null,
      registry,
    );
    panel.postMessage({ type: 'state', state });
    this.pushWorktreeStats(ticketId, panel, state.worktrees);
    this.refreshIcon(ticketId, panel);
    this.pushGateOptions(ticketId, panel);
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
   * Resolve and push the ticket's gate options. Only the latest request for a
   * still-live panel may post — a slower earlier probe must never overwrite a
   * newer answer, the same guard `pushWorktreeStats` carries.
   */
  private pushGateOptions(ticketId: number, panel: DashboardPanel): void {
    if (!this.loadGateOptions) return;
    this.gateControllers.get(ticketId)?.abort();
    const controller = new AbortController();
    this.gateControllers.set(ticketId, controller);
    const request = (this.gateRequests.get(ticketId) ?? 0) + 1;
    this.gateRequests.set(ticketId, request);
    void this.loadGateOptions(ticketId, controller.signal).then(
      (options) => {
        if (this.panels.get(ticketId) !== panel) return;
        if (this.gateRequests.get(ticketId) !== request) return;
        this.gateControllers.delete(ticketId);
        panel.postMessage({ type: 'gate-options', options });
      },
      (error) => {
        if (this.panels.get(ticketId) !== panel) return;
        if (this.gateRequests.get(ticketId) !== request) return;
        this.gateControllers.delete(ticketId);
        this.logError('karst: dashboard gate options failed', error);
      },
    );
  }

  /**
   * Push a transient inside-progress event to a ticket panel; no-op if not open.
   * Validated at this boundary (`parseInsideProgress`) — the webview is a trust
   * boundary in both directions, and a malformed event must never ship. Live
   * Ship rides this same generic union (Finding 12); there is no ship-specific
   * progress channel.
   */
  postInsideProgress(ticketId: number, event: InsideProgressEvent): void {
    const panel = this.panels.get(ticketId);
    if (!panel) return;
    const validated = parseInsideProgress(event);
    if (validated === null) return;
    panel.postMessage({ type: 'inside-progress', event: validated });
  }

  /**
   * Dispatch one opaque inside action id against the ticket's CURRENT action
   * registry. Rejects (logged) when the target fails its checks; unknown ids
   * are silently dropped — a stale or foreign id is not a fault to surface.
   */
  dispatchInsideAction(ticketId: number, actionId: string): void {
    const registry = this.registries.get(ticketId);
    if (!registry) return;
    const outcome = dispatchInsideAction(this.store, registry, actionId, {
      host: this.insideHost ?? NOOP_INSIDE_HOST,
      worktreeForRepo: (repo) =>
        listWorktreesByTicket(this.store, ticketId).find((w) => w.repo === repo)?.path,
      fs: { existsSync, realpathSync },
    });
    if (outcome.outcome === 'rejected') {
      this.logError(`karst: inside action rejected: ${outcome.reason}`, undefined);
    }
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

/** An absent host resolves nothing: every dispatch is unknown/rejected, never acted on. */
const NOOP_INSIDE_HOST: InsideActionHost = {
  openFile: () => undefined,
  openPr: () => undefined,
  openCommit: () => undefined,
  resumeStage: () => undefined,
  openFullEvidence: () => undefined,
  openBoundedEvidence: () => undefined,
};
