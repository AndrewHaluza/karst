import type { Store } from '../../store/db.js';
import type { AgentProvider, Manifest, TicketProvider } from '../../manifest/types.js';
import { getTicket, ticketLabel } from '../../store/tickets.js';
import type { LogError } from '../../logging/logger.js';
import type { GateStageKey } from '../../workflow/fixAttempts.js';
import type { GateStage } from '../../store/ticketGates.js';
import type { InsideProgressEvent } from '../../model/inside/progress.js';
import { resolveBaselineBranchForPath } from '../../manifest/baselineBranch.js';
import {
  buildDashboardState,
  type DashboardAgentContext,
  type DashboardState,
  type PathContext,
} from './state.js';
import type { AgentProcessId, DashboardActions, InsideActionResult } from './messages.js';
import type { ServerLogsReader } from './serverLogsReader.js';
import type { WorktreeStatsLoader } from './worktreeStats.js';
import type { GateOptionsLoader } from './gateOptions.js';
import type { GraphInsideInput } from '../../model/inside/graph.js';
import { hasLiveWork, LIVE_TICK_MS } from './liveTick.js';
import { compactTicketLabel } from '../../model/followUp.js';
import type { InsideActionHost } from './insideActions.js';
import {
  NOOP_INSIDE_HOST,
  SnapshotRegistry,
  toRegisteredGraphTarget,
} from './snapshotRegistry.js';
import { DashboardSelections } from './selections.js';
import { SupplementalLoaders, type SupplementalHost } from './supplementalLoaders.js';
import { DashboardConsole } from './consoleOutput.js';
import { attachMessagePump } from './messagePump.js';
import { agentContextFor, assignmentFor, repoNameFor, serviceNamesFor } from './resolvers.js';
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
export class DashboardManager {
  private readonly panels = new Map<number, DashboardPanel>();
  /**
   * The pending live-snapshot timer per ticket (§ liveTick.ts). A self-
   * rescheduling `setTimeout` rather than an interval: a push that finds
   * nothing running simply does not schedule the next one, so a settled ticket
   * costs nothing and there is no timer to remember to stop. Dies with the
   * panel — a timer that outlives its panel is a store read for a window
   * nobody is looking at.
   */
  private readonly liveTicks = new Map<number, ReturnType<typeof setTimeout>>();
  /** Panel-only selection memory (round switcher + findings repo scope). */
  private readonly selections = new DashboardSelections();
  /** Per-snapshot action capabilities + the grace window for superseded ones. */
  private readonly registry = new SnapshotRegistry();
  /** Supplemental async loaders (worktree stats, gate options, base branches). */
  private readonly loaders: SupplementalLoaders;
  /** Console/log forwarding boundary (progress events, gate/AI/server logs). */
  private readonly console: DashboardConsole;
  /** The manager side of the loaders' contract (live-panel check + re-push). */
  private readonly supplementalHost: SupplementalHost = {
    isCurrentPanel: (ticketId, panel) => this.panels.get(ticketId) === panel,
    repush: (ticketId, settlesActions) => {
      if (settlesActions) this.pushState(ticketId);
      else this.pushPassiveState(ticketId);
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
  ) {
    this.loaders = new SupplementalLoaders(
      loadStats,
      loadGateOptions,
      loadBranchCandidates,
      logError,
    );
    this.console = new DashboardConsole(
      store,
      (ticketId) => this.panels.get(ticketId),
      stageLogReader,
      agentLogReader,
      serverLogsReader,
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
      return;
    }

    const ticket = getTicket(this.store, ticketId);
    const panel = this.host.createPanel(
      compactTicketLabel(ticket, ticketLabel(ticket, this.labelTemplate?.())),
      ticketId,
      opts?.preserveFocus,
    );
    this.panels.set(ticketId, panel);

    // The factory's actions plus the detach callback bound to THIS ticket: the
    // webview's "Open in Window" message names no ticket, so the closure owns it.
    const actions: DashboardActions = {
      ...this.actionsFor(ticketId),
      onServerLogsDetach: () => this.onServerLogsDetach?.(ticketId),
    };
    // Message pump must never die on one bad message — routeAction validates,
    // and any downstream throw is contained so subsequent messages still flow.
    attachMessagePump(panel, {
      ticketId,
      actions,
      selections: this.selections,
      registry: this.registry,
      pushState: (id) => this.pushState(id),
      logError: this.logError,
    });
    panel.onDidChangeViewState((active) => {
      this.binding?.onDidActivate(ticketId, active);
      this.onViewActivated?.(ticketId, active);
      // A hidden panel stops its live tick, so coming back needs one catch-up
      // repaint — that push re-arms the loop. Guarded on there being live work
      // (`scheduleLiveTick` decides), and harmless otherwise: it is the same
      // snapshot every other push builds.
      if (panel.isVisible?.() === false) {
        // Going hidden cancels the tick already armed — the repaint it would
        // run is for a webview nobody can see.
        const armed = this.liveTicks.get(ticketId);
        if (armed) clearTimeout(armed);
        this.liveTicks.delete(ticketId);
        return;
      }
      if (this.liveTicks.has(ticketId)) return; // still ticking; nothing to catch up
      try {
        this.pushSnapshot(ticketId, {
          supplemental: false,
          live: true,
          settlesActions: false,
        });
      } catch (err) {
        this.logError('karst: dashboard visibility repaint failed', err);
      }
    });
    panel.onDidDispose(() => {
      if (this.panels.get(ticketId) !== panel) return;
      // The ACTIVE view can be closed while focused; the dispose is the only
      // signal that the focus is gone, so report it exactly like a deactivation.
      this.onViewActivated?.(ticketId, false);
      const tick = this.liveTicks.get(ticketId);
      if (tick) clearTimeout(tick);
      this.liveTicks.delete(ticketId);
      this.panels.delete(ticketId);
      // The async loaders abort and drop their per-ticket state; the round
      // switcher selection and findings repo scope die with the panel too (a
      // later open of the same ticket id starts at the defaults), and the
      // panel's action capabilities die with it: a disposed panel's ids must
      // never dispatch against a later snapshot.
      this.loaders.clear(ticketId);
      this.selections.clear(ticketId);
      this.registry.clear(ticketId);
    });

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

  /** Push a fresh state snapshot to a ticket panel; no-op if not open. */
  pushState(ticketId: number): void {
    this.pushSnapshot(ticketId, {
      supplemental: true,
      live: false,
      settlesActions: true,
    });
  }

  /**
   * Push a complete snapshot for host-external news without claiming it is the
   * response to any dashboard action currently in flight.
   */
  pushPassiveState(ticketId: number): void {
    this.pushSnapshot(ticketId, {
      supplemental: true,
      live: false,
      settlesActions: false,
    });
  }

  /**
   * Push news that changed only store-backed state. Unlike `pushState`, this
   * fully re-renders the snapshot but does not restart the async worktree or
   * gate-option loaders. It also cannot settle a pending dashboard action:
   * store news such as a usage delta is not that action's response.
   */
  pushStoreState(ticketId: number): void {
    this.pushSnapshot(ticketId, {
      supplemental: false,
      live: false,
      settlesActions: false,
    });
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
  private pushSnapshot(
    ticketId: number,
    mode: { supplemental: boolean; live: boolean; settlesActions: boolean },
  ): void {
    const { supplemental, live, settlesActions } = mode;
    const panel = this.panels.get(ticketId);
    if (!panel) return;
    // A fresh action registry PER SNAPSHOT: every state push is authoritative,
    // so the ids it mints are the only live capabilities. The registry itself
    // (with its host-only targets) never leaves this manager.
    //
    // A LIVE repaint is the SAME snapshot re-read, and the webview only updates
    // running clocks in place — it does not re-render its rows, so it keeps
    // displaying the ids of the build it last RENDERED. Superseding the
    // registry once a second would push those displayed ids into the grace
    // window and let them age out of it while a long-running stage (a gate, a
    // review findings lane) is still ticking, turning a click on a finding's
    // file link into "This action is no longer available" (869eja6uv). So a
    // repaint REUSES the current registry — the ids it already holds stay live,
    // and `register` memoizes by target so a re-mint of the same row is the
    // same id rather than unbounded growth. A real push (which re-renders the
    // webview with freshly minted ids) is what supersedes.
    const registry = this.registry.beginSnapshot(ticketId, supplemental);
    // The graph projection's controls (Slice 3 Task 11 / Slice 4 Task 4) ride
    // the SAME opaque typed-action seam: the projection is pure, so the host
    // injects the attach closure that mints ids in THIS snapshot's registry.
    const graphInside = this.graphInsideFor?.(ticketId) ?? null;
    if (graphInside) {
      graphInside.attach = (target) => {
        const action = registry.register(toRegisteredGraphTarget(target, ticketId));
        return action ?? undefined;
      };
    }
    const state = buildDashboardState(
      this.store,
      ticketId,
      this.pathContext?.(),
      this.ticketing?.(),
      this.approachPhases,
      this.isRepoRunnable,
      this.defaultProvider?.(),
      agentContextFor(this.agentContext?.(), this.manifest?.()),
      this.fixCapFor,
      (id) => {
        const manifest = this.manifest?.();
        return manifest ? serviceNamesFor(this.store, manifest, id) : [];
      },
      (processId) => assignmentFor(this.store, this.manifest?.(), ticketId, processId),
      registry,
      this.loaders.gateOptionsFor(ticketId),
      this.launchCheckout,
      // The inside ship rows name the repository, never the path the runtime
      // tables key by — the manifest's name for a recorded repoPath.
      (repo) => {
        const manifest = this.manifest?.();
        return manifest ? repoNameFor(manifest, repo) : undefined;
      },
      // The graph runtime's read-only projection (Slice 3 Task 11): built
      // host-side, null for a ticket with no graph run.
      graphInside,
      // The round switcher's current selection (Option B, T5): the state
      // builder resolves a stale/unknown key to that stage's latest attempt
      // itself, so the panel need not validate it against the snapshot.
      this.selections.attemptSelectionFor(ticketId),
      // The manifest's resolved default base branch, for the scope card's
      // "changed" affordance (§ per-repo base branch — live change). Absent
      // manifest → `''`, which never marks a real branch as overridden.
      (repoPath) => {
        const manifest = this.manifest?.();
        return manifest ? resolveBaselineBranchForPath(manifest, repoPath) : '';
      },
      // Cached candidates, warmed by the loaders below — never fetched HERE,
      // since this builder must stay synchronous.
      (repoPath) => this.loaders.branchCandidatesFor(repoPath),
      // Task 4.1: the ship-stage warning row's threshold. Absent manifest, or
      // the findings lane switched off entirely (`enabled: false` — the
      // shipped example config's alternative to lowering blockingSeverity),
      // both read as `'none'`: an `enabled: false` project records no
      // findings at all, so a leftover `blockingSeverity: 'high'` beside it
      // must not light up a row nothing on record can ever satisfy.
      (() => {
        const findings = this.manifest?.()?.review?.findings;
        return findings?.enabled === false ? 'none' : (findings?.blockingSeverity ?? 'none');
      })(),
      // The findings repo scope selection per stage (§ findings severity ramp):
      // panel memory, passed through to the quality reducers. Absent → "all".
      this.selections.findingsRepoSelectionFor(ticketId),
    );
    // A key the new snapshot no longer resolved to is dropped from panel
    // memory: `selectedAttempt` reports what the builder actually rendered,
    // so a mismatch means the requested key named no attempt this round —
    // there is nothing left worth remembering for the NEXT snapshot either.
    this.selections.pruneStaleAttempts(ticketId, state);
    this.selections.pruneStaleFindingsRepos(ticketId, state);
    // `live` marks a REPAINT of data the panel already had, as opposed to a
    // push that reports something happening. The webview defers a live repaint
    // while the user is mid-interaction (an action in flight, a text selection
    // being made) — a snapshot pushed once a second must never redraw over
    // what someone is doing, and only the sender knows which kind it is.
    panel.postMessage({
      type: 'state',
      state,
      ...(live ? { live: true } : {}),
      ...(!supplemental && !live ? { supplemental: false } : {}),
      ...(!settlesActions ? { settlesActions: false } : {}),
    });
    if (supplemental) {
      this.loaders.pushWorktreeStats(ticketId, panel, state.worktrees, this.supplementalHost);
      this.loaders.prefetchBranchCandidates(ticketId, panel, state.worktrees, this.supplementalHost);
      this.refreshIcon(ticketId, panel);
      this.loaders.pushGateOptions(ticketId, panel, settlesActions, this.supplementalHost);
    }
    this.scheduleLiveTick(ticketId, state);
  }

  /**
   * Keep the snapshot moving while the ticket is moving.
   *
   * The host pushes state when a stage transitions and when a gate completes,
   * but the inside block is process-led: a tester run, a findings lane, a
   * pr-description call and a running gate all open their store rows and then
   * take minutes, during which nothing pushed and the panel showed the world as
   * it was when the stage last moved. The `inside-progress` overlay narrates
   * only the ONE operation the driver knows about; every other row, and every
   * running row's elapsed time, needs the authoritative snapshot to be re-read.
   *
   * Re-armed from the state it just pushed (`hasLiveWork`), so it stops itself
   * the moment nothing is running — a settled or parked ticket schedules no
   * timer at all. A panel disposed between two ticks drops the push in the same
   * `pushState` guard every other caller relies on.
   *
   * A panel that is not VISIBLE stops the loop entirely rather than repainting
   * a webview nobody can see; `onDidChangeViewState` restarts it with one
   * catch-up repaint the moment the panel comes back. Visibility, never
   * activation: the dashboard's whole purpose is to be watched beside a
   * terminal the user is typing in, which is visible and inactive.
   */
  private scheduleLiveTick(ticketId: number, state: DashboardState): void {
    const pending = this.liveTicks.get(ticketId);
    if (pending) {
      clearTimeout(pending);
      this.liveTicks.delete(ticketId);
    }
    if (!hasLiveWork(state)) return;
    const panel = this.panels.get(ticketId);
    if (!panel) return;
    if (panel.isVisible?.() === false) return;
    const timer = setTimeout(() => {
      this.liveTicks.delete(ticketId);
      if (!this.panels.has(ticketId)) return;
      try {
        this.pushSnapshot(ticketId, {
          supplemental: false,
          live: true,
          settlesActions: false,
        });
      } catch (err) {
        // A tick is a repaint, never a mutation: a failed read (a deleted
        // ticket, a locked DB) must not take the extension host down, and it
        // must not re-arm — the next real push restarts the loop.
        this.logError('karst: dashboard live tick failed', err);
      }
    }, LIVE_TICK_MS);
    // Never hold the host's event loop open for a repaint.
    (timer as { unref?: () => void }).unref?.();
    this.liveTicks.set(ticketId, timer);
  }

  /**
   * Push a transient inside-progress event to a ticket panel; no-op if not open.
   */
  postInsideProgress(ticketId: number, event: InsideProgressEvent): void {
    this.console.postInsideProgress(ticketId, event);
  }

  /**
   * Answer a `stage-log-request`. The answer IS the terminal outcome (UI-R13).
   */
  requestStageLog(ticketId: number, stage: GateStage): void {
    this.console.requestStageLog(ticketId, stage);
  }

  /**
   * Answer an `agent-log-request`. The answer IS the terminal outcome (UI-R13).
   */
  requestAgentLog(ticketId: number, processId: AgentProcessId): void {
    this.console.requestAgentLog(ticketId, processId);
  }

  /**
   * Push one sanitized live chunk of a gate-lane AI process's output to the
   * ticket's panel; no-op if the panel is not open.
   */
  postAgentOutput(ticketId: number, processId: AgentProcessId, text: string): void {
    this.console.postAgentOutput(ticketId, processId, text);
  }

  /**
   * Push one sanitized live chunk of a gate stage's deterministic gate output
   * to the ticket's panel; no-op if the panel is not open.
   */
  postStageOutput(ticketId: number, stage: GateStage, text: string): void {
    this.console.postStageOutput(ticketId, stage, text);
  }

  /**
   * Answer a `server-logs-request`; the answer IS the terminal outcome (UI-R13).
   */
  requestServerLogs(ticketId: number): void {
    this.console.requestServerLogs(ticketId);
  }

  /** Answer a `server-logs-close`: stop polling for server log updates. */
  closeServerLogs(ticketId: number): void {
    this.console.closeServerLogs(ticketId);
  }

  /**
   * Push one sanitized live chunk of a server's log output to the ticket's
   * panel; no-op if the panel is not open.
   */
  postServerLogOutput(ticketId: number, service: string, text: string): void {
    this.console.postServerLogOutput(ticketId, service, text);
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

  /**
   * Push fresh state to every open panel. Used by background sweeps (e.g. PR
   * status sync) whose result may touch any open ticket, so the caller need not
   * track which ticket changed.
   */
  pushAll(): void {
    for (const ticketId of this.panels.keys()) this.pushState(ticketId);
  }

  openCount(): number { return this.panels.size; }

  /** Re-point the tab icon at the ticket's current status glyph. */
  private refreshIcon(ticketId: number, panel: DashboardPanel): void {
    const icon = this.iconFor?.(ticketId);
    if (icon) panel.setIcon(icon);
  }

  /** Whether a panel is currently open for a ticket (for the caller/tests). */
  isOpen(ticketId: number): boolean {
    return this.panels.has(ticketId);
  }

  /** The tickets with a currently open panel, for the external-change watcher. */
  openTicketIds(): number[] {
    return [...this.panels.keys()];
  }
}
