import type { Store } from '../../store/db.js';
import { getTicket, ticketLabel } from '../../store/tickets.js';
import type { TicketProvider } from '../../manifest/types.js';
import type { LogError } from '../../logging/logger.js';
import { buildDashboardState, type PathContext } from './state.js';
import { routeAction, type DashboardActions } from './messages.js';

/**
 * The subset of a `vscode.WebviewPanel` the manager touches. Modeling it as an
 * interface keeps `DashboardManager` host-agnostic and unit-testable without a
 * `vscode` module; the activation adapter supplies a real panel.
 */
export interface DashboardPanel {
  reveal(): void;
  postMessage(message: unknown): void;
  onDidReceiveMessage(handler: (message: unknown) => void): void;
  onDidDispose(handler: () => void): void;
  /** Update the tab icon (real: `panel.iconPath = Uri.file(path)`). */
  setIcon(path: string): void;
}

/** Factory the manager uses to mint panels (real: `createWebviewPanel`). */
export interface PanelHost {
  createPanel(title: string, ticketId: number): DashboardPanel;
}

/** Test double surface — extends the panel with recorded state + an emitter. */
export interface FakePanel extends DashboardPanel {
  title: string;
  revealed: number;
  disposed: boolean;
  posted: unknown[];
  /** Every `setIcon` path, in order — the live-tint assertion surface. */
  icons: string[];
  messageHandlers: Array<(m: unknown) => void>;
  disposeHandler?: () => void;
  dispose(): void;
  emit(message: unknown): void;
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
  ) {}

  /** Open (or reveal) the dashboard for a ticket and push its initial state. */
  openDashboard(ticketId: number): void {
    const existing = this.panels.get(ticketId);
    if (existing) {
      existing.reveal();
      return;
    }

    const panel = this.host.createPanel(
      ticketLabel(getTicket(this.store, ticketId), this.labelTemplate?.()),
      ticketId,
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
    panel.onDidDispose(() => this.panels.delete(ticketId));

    this.refreshIcon(ticketId, panel);
    this.pushState(ticketId);
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
    );
    panel.postMessage({ type: 'state', state });
    this.refreshIcon(ticketId, panel);
  }

  /**
   * Push a transient ship-progress label to a ticket panel; no-op if not open.
   *
   * Separate from `pushState` on purpose: the ship stage's live phase ("Pushing
   * branch…") is not in the store — `buildDashboardState` cannot re-derive it —
   * so it rides its own ephemeral message that the webview overlays on the "Now"
   * line while a ship is in flight, then discards on the next real state push.
   */
  postShipProgress(ticketId: number, label: string): void {
    const panel = this.panels.get(ticketId);
    if (!panel) return;
    panel.postMessage({ type: 'ship-progress', label });
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
