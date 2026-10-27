import type { Store } from '../../store/db.js';
import type { AgentProvider, Manifest, TicketProvider } from '../../manifest/types.js';
import type { LogError } from '../../logging/logger.js';
import type { GateStageKey } from '../../workflow/fixAttempts.js';
import { listSharedServersByTicket, type SharedServerView } from '../../store/sharedServers.js';
import type { DashboardAgentContext, PathContext } from './state.js';
import type { InsideActionResult } from './messages.js';
import type { ServerLogsReader } from './serverLogsReader.js';
import type { WorktreeStatsLoader } from './worktreeStats.js';
import type { GateOptionsLoader } from './gateOptions.js';
import { type BaselineRowsLoader } from './baselineRows.js';
import type { ShipPreviewLoader } from '../../workflow/shipPreview.js';
import type { GraphInsideInput } from '../../model/inside/graph.js';
import type { InsideActionHost } from './insideActions.js';
import { NOOP_INSIDE_HOST, SnapshotRegistry } from './snapshotRegistry.js';
import { DashboardSelections } from './selections.js';
import { SupplementalLoaders, type StoredArtifactsLoader, type SupplementalHost } from './supplementalLoaders.js';
import { DashboardConsole } from './consoleOutput.js';
import { DashboardManagerBase } from './managerBase.js';
import { LiveTicker } from './liveTicker.js';
import { openNewPanel } from './panelOpen.js';
import { PushMemory, pushSnapshot, type SnapshotPushDeps } from './snapshotPush.js';
import type {
  ActionsFactory,
  AgentLogReader,
  BranchCandidatesLoader,
  DashboardBinding,
  DashboardPanel,
  PanelHost,
  StageLogReader,
} from './panelTypes.js';

export type {
  ActionsFactory,
  AgentLogReader,
  BranchCandidatesLoader,
  DashboardBinding,
  DashboardPanel,
  FakePanel,
  PanelHost,
  StageLogReader,
} from './panelTypes.js';
export { ACTION_GRACE_MS } from './snapshotRegistry.js';

/**
 * One dashboard panel per ticket id (§14). `openDashboard` reveals an existing
 * panel rather than spawning a duplicate; disposal drops the panel so a later
 * open recreates it. State is pushed to the webview via `postMessage`.
 *
 * The manager composes the panel-scoped seams that used to live in one file:
 * the snapshot-scoped action registry + grace window (`SnapshotRegistry`), the
 * panel-only selection memory (`DashboardSelections`), the supplemental async
 * loaders (`SupplementalLoaders`), the console/log forwarders
 * (`DashboardConsole`), the webview message pump (`messagePump`) and the
 * manifest/agent resolvers (`resolvers`). It owns the panels and the snapshot
 * lifecycle; everything else is delegated.
 */
export class DashboardManager extends DashboardManagerBase {
  protected readonly panels = new Map<number, DashboardPanel>();
  /** The self-rescheduling live-snapshot timers (one per ticket). */
  private readonly ticks: LiveTicker;
  /** What each panel was last sent (structure key, debug state, tab icon). */
  private readonly memory = new PushMemory();
  /** Panel-only selection memory (round switcher + findings repo scope). */
  private readonly selections = new DashboardSelections();
  /** Per-snapshot action capabilities + the grace window for superseded ones. */
  private readonly registry = new SnapshotRegistry();
  /** Supplemental async loaders (worktree stats, gate options, base branches). */
  private readonly loaders: SupplementalLoaders;
  /** Console/log forwarding boundary (progress events, gate/AI/server logs). */
  protected readonly console: DashboardConsole;
  /** What `pushSnapshot` reads, assembled once from the constructor args. */
  protected readonly pushDeps: SnapshotPushDeps;
  /** The manager side of the loaders' contract (live-panel check + re-push). */
  private readonly supplementalHost: SupplementalHost = {
    isCurrentPanel: (ticketId, panel) => this.panels.get(ticketId) === panel,
    // A loader's follow-up only folds its result into the snapshot: it must
    // not restart the loaders (a second git/repo walk per open) nor tell the
    // webview to drop the worktree stats it just received.
    repush: (ticketId, settlesActions) => {
      pushSnapshot(this.pushDeps, ticketId, {
        kind: 'follow-up',
        supplemental: false,
        live: false,
        settlesActions,
      });
    },
  };

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
    /** Report a caught pump error to the Karst output channel. */
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
    /**
     * Live manifest getter, so the inside views resolve the REAL service names
     * and process assignments instead of empty lists. The manager is
     * manifest-free by contract; every manifest fact arrives through injected
     * accessors like this one.
     */
    private readonly manifest?: () => Manifest | undefined,
    /**
     * Whether a worktree may offer the "Launch Dev" action: a karst-extension
     * checkout AND the feature's own enabled flag (host-composed). Absent →
     * the state builder's default probe, which keeps the button off for
     * anything that is not a karst checkout.
     */
    private readonly launchCheckout?: (path: string) => boolean,
    /**
     * Reports raw panel activation — including LOSING it — so the host can
     * track which ticket's view is the window's ACTIVE view (sidebar
     * highlight). Called alongside the terminal binding; absent → no report.
     */
    private readonly onViewActivated?: (ticketId: number, active: boolean) => void,
    /**
     * The host-built graph Inside input (Slice 3 Task 11) — the manager never
     * reads the graph tables. Absent → the graph projection is inert, which is
     * the pre-wiring state. Keyed by ticket because the read is per-ticket.
     */
    private readonly graphInsideFor?: (ticketId: number) => GraphInsideInput | null,
    /**
     * Resolve a gate stage's console log for the terminal view. Absent → the
     * webview receives a named refusal rather than content (UI-R13).
     */
    private readonly stageLogReader?: StageLogReader,
    /**
     * Resolve a gate-lane AI process's console tail for the terminal view
     * (the UAT Tester / Review findings lane). Absent → the webview receives
     * a named refusal rather than content (UI-R13).
     */
    private readonly agentLogReader?: AgentLogReader,
    /**
     * List a repoPath's base-branch candidates (Task 4's
     * `listBaseBranchCandidates`, pre-bound with the git runner by the host).
     * `changeBaseRef` itself (Task 7) is bound into `DashboardActions` by the
     * `actionsFor` factory, like every other mutating action — this loader is
     * separate because it feeds `buildDashboardState`, which only the manager
     * calls. Absent → every worktree's combobox renders with no candidates;
     * the input stays free text either way.
     */
    private readonly loadBranchCandidates?: BranchCandidatesLoader,
    /**
     * Read and stream server log files for the combined logs view. Absent →
     * the webview receives a named refusal rather than content (UI-R13).
     */
    private readonly serverLogsReader?: ServerLogsReader,
    /**
     * Open this ticket's logs in the standalone server-logs panel, bound to the
     * panel's own ticket id. Absent → the "Open in Window" control is a no-op.
     */
    private readonly onServerLogsDetach?: (ticketId: number) => void,
    /** Debug sink (`[dashboard]` lines); absent or disabled → no tracing work at all. */
    private readonly debug?: { debug(msg: string): void; isDebugEnabled(): boolean },
    /**
     * The UAT report's changed-baseline rows (@arch:BASELINE-REVIEW): async git,
     * so they ride the supplemental loaders and are overlaid onto the snapshot's
     * `uat-report` artifact. Absent → no rows, the pre-feature panel.
     */
    loadBaselines?: BaselineRowsLoader,
    /** The Artifacts view's data (T2 store): async git, so it rides the supplemental loaders. */
    loadStoredArtifacts?: StoredArtifactsLoader,
    /**
     * The advisory ship preview (D142): async git, read only while the ship slot
     * is `confirm`/`retry`. Absent → no preview section, the pre-feature panel.
     */
    private readonly loadShipPreview?: ShipPreviewLoader,
  ) {
    super();
    this.loaders = new SupplementalLoaders(
      loadStats,
      loadGateOptions,
      loadBranchCandidates,
      logError,
      loadBaselines,
      loadStoredArtifacts,
      loadShipPreview,
    );
    this.ticks = new LiveTicker({
      panelFor: (ticketId) => this.panels.get(ticketId),
      repaint: (ticketId) => this.repaint(ticketId),
      logError,
    });
    this.pushDeps = {
      store,
      registry: this.registry,
      selections: this.selections,
      loaders: this.loaders,
      pathContext,
      ticketing,
      approachPhases,
      isRepoRunnable,
      defaultProvider,
      agentContext,
      fixCapFor,
      manifest,
      launchCheckout,
      graphInsideFor,
      sharedServersFor: (id) => this.sharedServersFor(id),
      panelFor: (ticketId) => this.panels.get(ticketId),
      supplementalHost: this.supplementalHost,
      refreshIcon: (ticketId, panel) => this.refreshIcon(ticketId, panel),
      ticks: this.ticks,
      memory: this.memory,
      debug,
    };
    this.console = new DashboardConsole(
      store,
      (ticketId) => this.panels.get(ticketId),
      stageLogReader,
      agentLogReader,
      serverLogsReader,
      // Shared rows' Logs action opens this same combined view, so its data
      // arrives from the SAME provider the state uses (D203).
      (id) => this.sharedServersFor(id).map((s) => ({ service: s.service, logPath: s.logPath })),
    );
  }

  /**
   * Open (or reveal) the dashboard for a ticket and push its initial state.
   * `preserveFocus` is for the terminal binding: the panel comes forward beside
   * the terminal the user clicked, without stealing the caret out of it.
   */
  openDashboard(ticketId: number, opts?: { preserveFocus?: boolean }): void {
    const existing = this.panels.get(ticketId);
    if (existing) {
      existing.reveal(opts?.preserveFocus);
      // A focus-taking reveal makes the panel the ACTIVE view; `onDidChangeViewState`
      // fires on changes, so the reveal that caused this one must be reported here
      // (idempotent and order-safe — a later event can only correct it).
      if (opts?.preserveFocus !== true) this.onViewActivated?.(ticketId, true);
      existing.postMessage({ type: 'attention' });
      return;
    }

    const panel = openNewPanel(
      {
        store: this.store,
        host: this.host,
        actionsFor: this.actionsFor,
        labelTemplate: this.labelTemplate,
        onServerLogsDetach: this.onServerLogsDetach,
        binding: this.binding,
        onViewActivated: this.onViewActivated,
        panels: this.panels,
        ticks: this.ticks,
        memory: this.memory,
        loaders: this.loaders,
        selections: this.selections,
        registry: this.registry,
        pushState: (id) => this.pushState(id),
        repaint: (id) => this.repaint(id),
        logError: this.logError,
      },
      ticketId,
      opts?.preserveFocus,
    );

    this.refreshIcon(ticketId, panel);
    this.pushState(ticketId);
    this.postBind(panel);
    // Same explicit report as the reveal path: creation focuses the panel, and
    // `onDidChangeViewState` fires on changes, not on the initial activation.
    if (opts?.preserveFocus !== true) this.onViewActivated?.(ticketId, true);
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

  /**
   * Re-read the advisory ship preview and push the fresh snapshot. The explicit
   * Refresh intent (D142): the awaited read happens FIRST, so the state push
   * carries the new facts and settles the webview's Refresh pending — whether
   * or not anything changed. No-op when the panel is not open.
   */
  async refreshShipPreview(ticketId: number): Promise<void> {
    const panel = this.panels.get(ticketId);
    if (!panel) return;
    await this.loaders.reloadShipPreview(ticketId, panel, this.supplementalHost);
    this.pushState(ticketId);
  }

  /**
   * The shared (baseline) services this ticket consumes — the read-only half of
   * its stack. Built here because the manager holds the live manifest getter;
   * `buildDashboardState` receives it as an injected fact like every other
   * manifest-derived row.
   */
  private sharedServersFor(ticketId: number): SharedServerView[] {
    const manifest = this.manifest?.();
    return manifest ? listSharedServersByTicket(this.store, manifest, ticketId) : [];
  }

  /**
   * Dispatch one opaque inside action id against the ticket's CURRENT action
   * registry. Returns the terminal outcome so the message pump can report the
   * REAL result to the webview (UI-R13).
   */
  dispatchInsideAction(ticketId: number, actionId: string): InsideActionResult {
    return this.registry.dispatch(ticketId, actionId, {
      store: this.store,
      host: this.insideHost ?? NOOP_INSIDE_HOST,
      logError: this.logError,
    });
  }

  /** One live (clock-only) repaint: the tick and the visibility catch-up. */
  private repaint(ticketId: number): void {
    pushSnapshot(this.pushDeps, ticketId, {
      kind: 'live',
      supplemental: false,
      live: true,
      settlesActions: false,
    });
  }

  /** Re-point the tab icon at the ticket's current status glyph. */
  private refreshIcon(ticketId: number, panel: DashboardPanel): void {
    const icon = this.iconFor?.(ticketId);
    if (!icon || this.memory.iconSet.get(ticketId) === icon) return;
    this.memory.iconSet.set(ticketId, icon);
    panel.setIcon(icon);
  }

}
