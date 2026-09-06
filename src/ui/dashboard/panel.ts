import type { Store } from '../../store/db.js';
import type { AgentProvider, Manifest } from '../../manifest/types.js';
import { getTicket, ticketLabel } from '../../store/tickets.js';
import type { TicketProvider } from '../../manifest/types.js';
import type { LogError } from '../../logging/logger.js';
import type { GateStageKey } from '../../workflow/fixAttempts.js';
import type { GateStage } from '../../store/ticketGates.js';
import { existsSync, realpathSync } from 'node:fs';
import type { InsideProgressEvent } from '../../model/inside/progress.js';
import type { SessionConfiguredInput } from '../../model/inside/agent.js';
import { listWorktreesByTicket, listServersByTicket, type WorktreeView } from '../../store/dashboard.js';
import { resolveBaselineBranchForPath } from '../../manifest/baselineBranch.js';
import { resolveProcessAssignment } from '../../agent/processAssignment.js';
import { resolveProvider } from '../../agent/provider.js';
import { resolveModelForProvider } from '../../agent/models.js';
import { isRunnable } from '../../manifest/runnable.js';
import {
  InsideActionRegistry,
  dispatchInsideAction,
  type InsideActionHost,
  type InsideActionTarget,
} from './insideActions.js';
import {
  buildDashboardState,
  type DashboardAgentContext,
  type DashboardState,
  type PathContext,
} from './state.js';
import { parseInsideProgress, parseWebviewMessage, routeAction, type DashboardActions } from './messages.js';
import type { InsideActionResult, StageLogResult } from './messages.js';
import type { AgentProcessId } from './messages.js';
import type { ServerLogsReader } from './serverLogsReader.js';
import type { WorktreeStatsLoader } from './worktreeStats.js';
import type { GateOptions, GateOptionsLoader } from './gateOptions.js';
import type { GraphInsideInput, GraphActionTarget } from '../../model/inside/graph.js';
import { readRequestId, reportAction } from '../../model/actionResult.js';
import { hasLiveWork, LIVE_TICK_MS } from './liveTick.js';
import { compactTicketLabel } from '../../model/followUp.js';

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
  /**
   * Whether the panel's webview is on screen at all (real: `panel.visible`) —
   * unlike `active`, which is true only when the user is ON it. A dashboard
   * watched beside a terminal the user is typing in is VISIBLE and inactive,
   * which is the live tick's main scenario, so visibility is what gates the
   * repaint. Absent → assume visible, which is exactly the pre-tick behavior.
   */
  isVisible?(): boolean;
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
  /** Whether the fake reports itself on screen — drives `isVisible`. */
  visible: boolean;
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

/** Resolve one gate stage's console log host-side (store + fs). */
export type StageLogReader = (ticketId: number, stage: GateStage) => StageLogResult;

/** Resolve one gate-lane AI process's console tail host-side (fs). */
export type AgentLogReader = (ticketId: number, processId: AgentProcessId) => StageLogResult;

/**
 * List the base-branch candidates for a worktree's repoPath, pre-bound by the
 * host to `listBaseBranchCandidates` (Task 4) with the git runner it needs.
 * Never throws (the underlying lister already swallows git failures to `[]`).
 */
export type BranchCandidatesLoader = (repoPath: string) => Promise<string[]>;

/**
 * How long a superseded snapshot's action ids stay dispatchable — the window a
 * click already in flight when a repaint landed has to survive. Sized for a
 * webview→host round trip, not for the repaint cadence.
 */
export const ACTION_GRACE_MS = 5000;

/** Memory bound on the grace list; the time window above is what actually decides. */
const MAX_GRACE_DEPTH = 10;

/** Content equality for `GateOptions` — a fresh resolution is a new object every time. */
function sameGateOptions(a: GateOptions, b: GateOptions): boolean {
  return sameOptions(a.uat, b.uat) && sameOptions(a.review, b.review);
}

function sameOptions(
  a: readonly { name: string; disabled: boolean }[],
  b: readonly { name: string; disabled: boolean }[],
): boolean {
  return (
    a.length === b.length &&
    a.every((x, i) => x.name === b[i]!.name && x.disabled === b[i]!.disabled)
  );
}

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
  /**
   * The last resolved gate options per ticket, so `pushState` can render the
   * would-run gate names as pending rows before the stage runs. Dies with the
   * panel; a stale entry for a closed panel is a leak.
   */
  private readonly gateOptionsCache = new Map<number, GateOptions>();
  /** The CURRENT snapshot-scoped action registry per ticket (host-only targets). */
  private readonly registries = new Map<number, InsideActionRegistry>();
  /**
   * The registries of superseded snapshots, newest last, with the moment each
   * was superseded — the grace window for a click already in flight when a
   * repaint replaced the render it was posted from.
   *
   * Bounded by TIME (`ACTION_GRACE_MS`), not by a generation count: what the
   * window has to cover is one webview→host round trip, and tying it to "the
   * previous snapshot" made its real length the tick period — so a faster tick
   * would silently shorten it and a slower one stretch it. `MAX_GRACE_DEPTH`
   * is the memory bound only.
   */
  private readonly priorRegistries = new Map<
    number,
    Array<{ registry: InsideActionRegistry; supersededAt: number }>
  >();
  private readonly generations = new Map<number, number>();
  /**
   * The pending live-snapshot timer per ticket (§ liveTick.ts). A self-
   * rescheduling `setTimeout` rather than an interval: a push that finds
   * nothing running simply does not schedule the next one, so a settled ticket
   * costs nothing and there is no timer to remember to stop. Dies with the
   * panel — a timer that outlives its panel is a store read for a window
   * nobody is looking at.
   */
  private readonly liveTicks = new Map<number, ReturnType<typeof setTimeout>>();
  /**
   * The round switcher's current selection per ticket (Option B, T5) —
   * host-held, like every other panel read: the webview posts a selection,
   * the panel remembers it and re-renders through the normal state push. A
   * ticket with no selection is absent from the map entirely, which is what
   * keeps `buildDashboardState`'s `attemptSelection` argument (and therefore
   * its output) unchanged for every ticket that never touched a tab. Dies
   * with the panel (cleared on dispose) so a selection never leaks to a later
   * ticket that happens to reuse the id.
   */
  private readonly attemptSelections = new Map<number, ReadonlyMap<GateStage, string>>();
  /**
   * Base-branch candidates per repoPath (§ per-repo base branch — live
   * change), warmed lazily by `prefetchBranchCandidates` and shared across
   * every open ticket: a repoPath's git listing does not vary by ticket. A
   * repoPath absent from the map has not been fetched yet — `[]` in state
   * until then, never a host round trip the webview waits on.
   */
  private readonly branchCandidates = new Map<string, string[]>();

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
      const parsed = parseWebviewMessage(raw);
      if (!parsed) return;
      if (parsed.type === 'select-gate-attempt') {
        // Pure read: the selection is panel memory only — it never touches
        // the store, never mutates the ticket, and has no
        // `DashboardActions` method (messages.ts's `routeAction` deliberately
        // does not carry it). Recording it and re-rendering through the
        // normal state push is the whole handling.
        const current = this.attemptSelections.get(ticketId) ?? new Map<GateStage, string>();
        const next = new Map(current);
        next.set(parsed.stage, parsed.key);
        this.attemptSelections.set(ticketId, next);
        this.pushState(ticketId);
        return;
      }
      if (parsed.type === 'inside-action') {
        // An inside dispatch's outcome is known synchronously; the generic
        // seam's unconditional ack would report a rejected or stale dispatch
        // as success (UI-R13). Post the returned result for this request.
        // (`inside-action` never resolves to `Promise<InsideActionResult>` —
        // only `change-base-ref`, handled in its own branch below, does.)
        const result = routeAction(raw, actions) as InsideActionResult | void | Promise<void>;
        if (isInsideActionResult(result)) {
          if (requestId) {
            panel.postMessage({
              type: 'action-result',
              requestId,
              ok: result.ok,
              ...(result.message ? { message: result.message } : {}),
            });
          }
          return;
        }
        // A void/promise-returning factory keeps its exact old semantics.
        void reportAction(requestId, (message) => panel.postMessage(message), () => result);
        return;
      }
      if (parsed.type === 'change-base-ref') {
        // Refusal (dirty/conflict/base-missing/failed) must change NOTHING:
        // a repaint here would risk showing a new base the change never
        // actually reached. Success repaints so the scope card's `baseRef`
        // reflects what git actually did — the ONE case (besides
        // `select-gate-attempt`) this pump repaints outside a `state` push
        // the caller already scheduled. Same isInsideActionResult contract as
        // `inside-action`, just asynchronous: the outcome is a promise of one.
        const result = routeAction(raw, actions) as Promise<InsideActionResult>;
        void result.then(
          (outcome) => {
            if (outcome.ok) this.pushState(ticketId);
            if (!requestId) return;
            try {
              panel.postMessage({
                type: 'action-result',
                requestId,
                ok: outcome.ok,
                ...(outcome.message ? { message: outcome.message } : {}),
              });
            } catch {
              // A disposed panel. The change already ran (or was refused); losing
              // the receipt is not a reason to surface an error nobody can act on.
            }
          },
          (err: unknown) => {
            this.logError('karst: change base ref failed', err);
            if (!requestId) return;
            try {
              panel.postMessage({
                type: 'action-result',
                requestId,
                ok: false,
                message: 'Changing the base branch failed.',
              });
            } catch {
              // A disposed panel.
            }
          },
        );
        return;
      }
      void reportAction(requestId, (message) => panel.postMessage(message), () => {
        try {
          const result = routeAction(raw, actions);
          if (result && typeof (result as PromiseLike<void>).then === 'function') {
            return (result as Promise<void>).catch((err: unknown) => {
              this.logError('karst: dashboard action failed', err);
              throw err;
            });
          }
          // An InsideActionResult cannot reach this seam: `inside-action` is
          // handled above, and no other case produces one.
          return result as void | Promise<void>;
        } catch (err) {
          this.logError('karst: dashboard action failed', err);
          throw err;
        }
      });
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
      this.statsControllers.get(ticketId)?.abort();
      this.gateControllers.get(ticketId)?.abort();
      const tick = this.liveTicks.get(ticketId);
      if (tick) clearTimeout(tick);
      this.liveTicks.delete(ticketId);
      this.panels.delete(ticketId);
      this.statsRequests.delete(ticketId);
      this.statsControllers.delete(ticketId);
      this.gateRequests.delete(ticketId);
      this.gateControllers.delete(ticketId);
      this.gateOptionsCache.delete(ticketId);
      // The round switcher's selection dies with the panel — a later open of
      // the same ticket id starts at the default (latest attempt) selection.
      this.attemptSelections.delete(ticketId);
      // The panel's action capabilities die with it: a disposed panel's ids
      // must never dispatch against a later snapshot.
      this.registries.get(ticketId)?.dispose();
      this.registries.delete(ticketId);
      for (const entry of this.priorRegistries.get(ticketId) ?? []) entry.registry.dispose();
      this.priorRegistries.delete(ticketId);
      this.generations.delete(ticketId);
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
    const existing = this.registries.get(ticketId);
    let registry: InsideActionRegistry;
    if (supplemental || !existing) {
      const generation = (this.generations.get(ticketId) ?? 0) + 1;
      this.generations.set(ticketId, generation);
      registry = new InsideActionRegistry(generation, ticketId);
      // The snapshot the user was LOOKING AT stays dispatchable for a short
      // WALL-CLOCK window. A click is posted against the ids of the render on
      // screen, and with a repaint every second that render can be superseded
      // while the message is in flight — rejecting it would report "no longer
      // available" for a button the user just pressed. Bounded and short: a
      // capability must still die promptly.
      if (existing) {
        const grace = this.priorRegistries.get(ticketId) ?? [];
        grace.push({ registry: existing, supersededAt: Date.now() });
        this.priorRegistries.set(ticketId, grace);
      }
      this.pruneGrace(ticketId);
      this.registries.set(ticketId, registry);
    } else {
      registry = existing;
    }
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
      this.agentContext?.(),
      this.fixCapFor,
      (id) => this.serviceNamesFor(id),
      (processId) => this.assignmentFor(ticketId, processId),
      registry,
      this.gateOptionsCache.get(ticketId),
      this.launchCheckout,
      // The inside ship rows name the repository, never the path the runtime
      // tables key by — the manifest's name for a recorded repoPath.
      (repo) => this.repoNameFor(repo),
      // The graph runtime's read-only projection (Slice 3 Task 11): built
      // host-side, null for a ticket with no graph run.
      graphInside,
      // The round switcher's current selection (Option B, T5): the state
      // builder resolves a stale/unknown key to that stage's latest attempt
      // itself, so the panel need not validate it against the snapshot.
      this.attemptSelectionFor(ticketId),
      // The manifest's resolved default base branch, for the scope card's
      // "changed" affordance (§ per-repo base branch — live change). Absent
      // manifest → `''`, which never marks a real branch as overridden.
      (repoPath) => {
        const manifest = this.manifest?.();
        return manifest ? resolveBaselineBranchForPath(manifest, repoPath) : '';
      },
      // Cached candidates, warmed by `prefetchBranchCandidates` below — never
      // fetched HERE, since this builder must stay synchronous.
      (repoPath) => this.branchCandidates.get(repoPath) ?? [],
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
    );
    // A key the new snapshot no longer resolved to is dropped from panel
    // memory: `selectedAttempt` reports what the builder actually rendered,
    // so a mismatch means the requested key named no attempt this round —
    // there is nothing left worth remembering for the NEXT snapshot either.
    this.pruneStaleAttemptSelections(ticketId, state);
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
      this.pushWorktreeStats(ticketId, panel, state.worktrees);
      this.prefetchBranchCandidates(ticketId, panel, state.worktrees);
      this.refreshIcon(ticketId, panel);
      this.pushGateOptions(ticketId, panel, settlesActions);
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
   * Drop every superseded registry past the grace window (or past the depth
   * bound), disposing it — a capability that outlives its window is exactly
   * what the snapshot scoping exists to prevent.
   */
  private pruneGrace(ticketId: number): void {
    const grace = this.priorRegistries.get(ticketId);
    if (!grace) return;
    const cutoff = Date.now() - ACTION_GRACE_MS;
    while (grace.length > 0 && (grace[0]!.supersededAt < cutoff || grace.length > MAX_GRACE_DEPTH)) {
      grace.shift()!.registry.dispose();
    }
    if (grace.length === 0) this.priorRegistries.delete(ticketId);
  }

  /** This ticket's round switcher selection, plain-object shaped for `buildDashboardState`. */
  private attemptSelectionFor(ticketId: number): Partial<Record<'uat' | 'review', string>> {
    return Object.fromEntries(this.attemptSelections.get(ticketId) ?? []);
  }

  /**
   * Drop any selection the snapshot just rendered did NOT resolve to — the
   * state builder falls back to latest for a key naming no recorded attempt
   * (a stale panel selection, or a ticket that has since re-run the stage),
   * and a selection that has already stopped meaning anything should not
   * keep being requested on every following push.
   */
  private pruneStaleAttemptSelections(ticketId: number, state: DashboardState): void {
    const current = this.attemptSelections.get(ticketId);
    if (!current || current.size === 0) return;
    let changed = false;
    const next = new Map(current);
    for (const stage of ['uat', 'review'] as const) {
      const requested = current.get(stage);
      if (requested === undefined) continue;
      if (state.insideViews[stage]?.selectedAttempt !== requested) {
        next.delete(stage);
        changed = true;
      }
    }
    if (!changed) return;
    if (next.size === 0) this.attemptSelections.delete(ticketId);
    else this.attemptSelections.set(ticketId, next);
  }

  /**
   * The runnable services in the ticket's scope, by repository NAME. Non-runnable
   * repositories are absent by construction (isRunnable is the only gate) — a
   * repo with no `service:` block has no process to name.
   */
  private serviceNamesFor(ticketId: number): string[] {
    const manifest = this.manifest?.();
    if (!manifest) return [];
    const scoped = new Set(getTicket(this.store, ticketId)?.selectedRepos ?? []);
    return Object.entries(manifest.repositories)
      .filter(([name, repo]) => scoped.has(name) && isRunnable(repo))
      .map(([name]) => name);
  }

  /**
   * The manifest repository NAME for a recorded repo value — the runtime
   * tables (`ship_repo_steps`, `prs`, `merge_checks`) key by repo PATH, and
   * the inside rows must say "Karst-extention", never
   * "/Users/nd/Work/projects/karst/". A path the manifest does not know
   * (deleted repo, foreign row) falls back to the raw value.
   */
  private repoNameFor(repo: string): string | undefined {
    const manifest = this.manifest?.();
    if (!manifest) return undefined;
    for (const [name, def] of Object.entries(manifest.repositories)) {
      if (def.repoPath === repo) return name;
    }
    return undefined;
  }

  /**
   * The provider/model karst is CONFIGURED to run for one inside process —
   * shown before any recorded segment exists. Never the recorded identity: a
   * process_runs snapshot is what actually ran and outranks this everywhere it
   * exists (model/inside/agent.ts).
   */
  private assignmentFor(
    ticketId: number,
    processId: 'session' | 'tester' | 'review',
  ): SessionConfiguredInput | null {
    const manifest = this.manifest?.();
    if (!manifest) return null;
    const ticket = getTicket(this.store, ticketId);
    if (processId === 'session') {
      // The implementation session has no process role: it is the ticket's own
      // agent, resolved by the launch precedence rule.
      const provider = resolveProvider(ticket?.agentProvider ?? undefined, manifest.agentProvider);
      return { provider, model: resolveModelForProvider(provider, ticket?.model ?? null, manifest.defaultModel) ?? null };
    }
    const role = processId === 'tester' ? 'uat-tester' : 'review';
    const snapshot = resolveProcessAssignment(manifest, role, {
      provider: ticket?.agentProvider ?? undefined,
      model: ticket?.model ?? undefined,
    });
    // NULL is configured ABSENCE (`enabled: false`), not "unknown" — the caller
    // renders it as a disabled process, never as a missing lookup.
    return snapshot ? { provider: snapshot.provider, model: snapshot.model ?? null } : null;
  }

  /**
   * Warm `branchCandidates` for every worktree this snapshot rendered that
   * has not been fetched yet (§ per-repo base branch — live change). Never
   * refetches a repoPath already cached — the listing does not change while
   * the panel is open, and a warm cache must not cost a git call on every
   * tick. Once resolved, a passive repaint (never `pushState`: this is
   * host-external news, not the response to any in-flight action) lets the
   * scope card's combobox pick up the newly loaded options.
   */
  private prefetchBranchCandidates(
    ticketId: number,
    panel: DashboardPanel,
    worktrees: readonly WorktreeView[],
  ): void {
    if (!this.loadBranchCandidates) return;
    const missing = [...new Set(worktrees.map((w) => w.repo))].filter(
      (repo) => !this.branchCandidates.has(repo),
    );
    if (missing.length === 0) return;
    void Promise.all(
      missing.map((repo) =>
        this.loadBranchCandidates!(repo).then(
          (names) => this.branchCandidates.set(repo, names),
          () => this.branchCandidates.set(repo, []),
        ),
      ),
    ).then(() => {
      if (this.panels.get(ticketId) !== panel) return;
      this.pushPassiveState(ticketId);
    });
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
  private pushGateOptions(
    ticketId: number,
    panel: DashboardPanel,
    settlesActions: boolean,
  ): void {
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
        // Remember the resolved names so the follow-up snapshot can render
        // them as pending gate rows. Preserve the originating snapshot's
        // action-settlement authority: an async supplement to passive news is
        // still passive. Only a CHANGE re-pushes, or this would loop forever.
        const previous = this.gateOptionsCache.get(ticketId);
        this.gateOptionsCache.set(ticketId, options);
        panel.postMessage({ type: 'gate-options', options });
        if (!previous || !sameGateOptions(previous, options)) {
          if (settlesActions) this.pushState(ticketId);
          else this.pushPassiveState(ticketId);
        }
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
   * Answer a `stage-log-request`: resolve the log via the injected reader and
   * post the `stage-log` message. The answer IS the terminal outcome — always
   * sent (ok or error), never left to a watchdog (UI-R13).
   */
  requestStageLog(ticketId: number, stage: GateStage): void {
    const panel = this.panels.get(ticketId);
    if (!panel) return;
    const result = this.stageLogReader
      ? this.stageLogReader(ticketId, stage)
      : { kind: 'error', message: 'No console log source is configured.' };
    panel.postMessage({ type: 'stage-log', stage, result });
  }

  /**
   * Answer an `agent-log-request`: resolve the process's console tail via the
   * injected reader and post the `agent-log` message. The answer IS the
   * terminal outcome — always sent (ok or error), never left to a watchdog
   * (UI-R13).
   */
  requestAgentLog(ticketId: number, processId: AgentProcessId): void {
    const panel = this.panels.get(ticketId);
    if (!panel) return;
    const result = this.agentLogReader
      ? this.agentLogReader(ticketId, processId)
      : { kind: 'error', message: 'No console log source is configured.' };
    panel.postMessage({ type: 'agent-log', processId, result });
  }

  /**
   * Push one sanitized live chunk of a gate-lane AI process's output to the
   * ticket's panel; no-op if the panel is not open. The text is already
   * sanitized and bounded host-side (the `AgentConsole` sink); this boundary
   * forwards it verbatim to the open terminal view.
   */
  postAgentOutput(ticketId: number, processId: AgentProcessId, text: string): void {
    const panel = this.panels.get(ticketId);
    if (!panel) return;
    panel.postMessage({ type: 'agent-output', processId, text });
  }

  /**
   * Push one sanitized live chunk of a gate stage's deterministic gate output
   * to the ticket's panel; no-op if the panel is not open. Sanitized host-side
   * (the `GateConsole` sink); this boundary forwards it verbatim to the open
   * stage console.
   */
  postStageOutput(ticketId: number, stage: GateStage, text: string): void {
    const panel = this.panels.get(ticketId);
    if (!panel) return;
    panel.postMessage({ type: 'stage-output', stage, text });
  }

  /**
   * Answer a `server-logs-request`: read all server log files via the injected
   * reader, start polling for live updates, and post the `server-logs` message.
   * The answer IS the terminal outcome — always sent (ok or error), never left
   * to a watchdog (UI-R13).
   */
  requestServerLogs(ticketId: number): void {
    const panel = this.panels.get(ticketId);
    if (!panel) return;
    if (!this.serverLogsReader) {
      panel.postMessage({ type: 'server-logs', servers: [] });
      return;
    }
    const servers = listServersByTicket(this.store, ticketId);
    const logServers = servers.map((s) => ({ service: s.service, logPath: s.logPath }));
    const result = this.serverLogsReader.readLogs(logServers);
    panel.postMessage({ type: 'server-logs', servers: result.servers });
    this.serverLogsReader.startPolling(logServers, ticketId, (tid, service, text) =>
      this.postServerLogOutput(tid, service, text),
    );
  }

  /**
   * Answer a `server-logs-close`: stop polling for server log updates. No-op
   * if the panel is not open or no reader is configured.
   */
  closeServerLogs(ticketId: number): void {
    this.serverLogsReader?.stopPolling(ticketId);
  }

  /**
   * Push one sanitized live chunk of a server's log output to the ticket's
   * panel; no-op if the panel is not open.
   */
  postServerLogOutput(ticketId: number, service: string, text: string): void {
    const panel = this.panels.get(ticketId);
    if (!panel) return;
    panel.postMessage({ type: 'server-log-output', service, text });
  }

  /**
   * Dispatch one opaque inside action id against the ticket's CURRENT action
   * registry. Rejects (logged) when the target fails its checks; unknown ids
   * are silently dropped — a stale or foreign id is not a fault to surface.
   * Returns the terminal outcome so the message pump can report the REAL
   * result to the webview (UI-R13): a rejected or stale dispatch is never
   * acknowledged as success.
   */
  dispatchInsideAction(ticketId: number, actionId: string): InsideActionResult {
    // Current snapshot first, then the ONE it superseded: an id only ever
    // resolves against its own generation, so trying both is a grace window,
    // not a widening of what a given id can reach.
    const registry = this.registries.get(ticketId);
    if (!registry) return { ok: false, message: 'This action is no longer available.' };
    const dispatchAgainst = (target: InsideActionRegistry): ReturnType<typeof dispatchInsideAction> =>
      dispatchInsideAction(this.store, target, actionId, {
        host: this.insideHost ?? NOOP_INSIDE_HOST,
        worktreeForRepo: (repo) =>
          listWorktreesByTicket(this.store, ticketId).find((w) => w.repo === repo)?.path,
        fs: { existsSync, realpathSync },
      });
    let outcome = dispatchAgainst(registry);
    if (outcome.outcome === 'unknown') {
      this.pruneGrace(ticketId);
      // Newest first: an id resolves only against its own generation, so this
      // is a grace window, never a widening of what a given id can reach.
      const grace = this.priorRegistries.get(ticketId) ?? [];
      for (let i = grace.length - 1; i >= 0 && outcome.outcome === 'unknown'; i -= 1) {
        outcome = dispatchAgainst(grace[i]!.registry);
      }
    }
    if (outcome.outcome === 'rejected') {
      this.logError(`karst: inside action rejected: ${outcome.reason}`, undefined);
      // The reason is host diagnostic prose and may name a path — never send it
      // to the webview. The user-facing message is a fixed string.
      return { ok: false, message: 'This action could not be run.' };
    }
    if (outcome.outcome === 'unknown') {
      // A stale or foreign capability is not a success.
      return { ok: false, message: 'This action is no longer available.' };
    }
    return { ok: true };
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

  /** The tickets with a currently open panel, for the external-change watcher. */
  openTicketIds(): number[] {
    return [...this.panels.keys()];
  }
}

/** Narrow a routed action's return to the synchronous inside outcome, if that is what it is. */
function isInsideActionResult(
  v: InsideActionResult | void | Promise<void>,
): v is InsideActionResult {
  return typeof v === 'object' && v !== null && typeof (v as { ok?: unknown }).ok === 'boolean';
}

/** An absent host resolves nothing: every dispatch is unknown/rejected, never acted on. */
const NOOP_INSIDE_HOST: InsideActionHost = {
  openFile: () => undefined,
  openPr: () => undefined,
  openCommit: () => undefined,
  resumeStage: () => undefined,
  openFullEvidence: () => undefined,
  openBoundedEvidence: () => undefined,
  openSession: () => undefined,
  graphOpenSession: () => undefined,
  graphStop: () => undefined,
  graphResume: () => undefined,
  graphRestart: () => undefined,
  graphReplan: () => undefined,
  graphConfirm: () => undefined,
  graphMarkImpl: () => undefined,
  graphDiscardNode: () => undefined,
  graphEditOverride: () => undefined,
};

/** The graph projection's ticket-less target, stamped with the registry's
 *  ticket — the ONLY place the projection's targets become dispatchable
 *  capabilities. Exhaustive over the closed `GraphActionTarget` union. */
function toRegisteredGraphTarget(
  target: GraphActionTarget,
  ticketId: number,
): InsideActionTarget {
  switch (target.kind) {
    case 'graph-open-session':
      return { kind: 'graph-open-session', ticketId, session: target.session };
    case 'graph-stop':
      return { kind: 'graph-stop', ticketId, graphRunId: target.graphRunId };
    case 'graph-resume':
      return { kind: 'graph-resume', ticketId, graphRunId: target.graphRunId };
    case 'graph-restart':
      return { kind: 'graph-restart', ticketId, graphRunId: target.graphRunId };
    case 'graph-replan':
      return { kind: 'graph-replan', ticketId, graphRunId: target.graphRunId };
    case 'graph-confirm':
      return { kind: 'graph-confirm', ticketId, graphRunId: target.graphRunId };
    case 'graph-mark-impl':
      return { kind: 'graph-mark-impl', ticketId, graphRunId: target.graphRunId };
    case 'graph-discard-node':
      return { kind: 'graph-discard-node', ticketId, nodeRunId: target.nodeRunId };
    case 'graph-edit-override':
      return { kind: 'graph-edit-override', ticketId, nodeRunId: target.nodeRunId };
  }
}
