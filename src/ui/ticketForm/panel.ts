import type { Store } from '../../store/db.js';
import { getTicket, ticketLabel } from '../../store/tickets.js';
import type { Manifest } from '../../manifest/types.js';
import type { PoolAgent } from '../../agents/pool.js';
import type { LogError } from '../../logging/logger.js';
import { buildTicketFormState, type TicketFormState } from './state.js';
import {
  parseTicketFormMessage,
  routeTicketFormAction,
  type TicketFormActions,
  type TicketFormHostMessage,
} from './messages.js';
import {
  bundledModelCatalog,
  type ModelCatalog,
} from '../../agent/modelCatalog.js';
import { readRequestId, reportAction } from '../../model/actionResult.js';
import { compactTicketLabel } from '../../model/followUp.js';

/**
 * The subset of a `vscode.WebviewPanel` the ticket-form manager touches. Modeled
 * as an interface so the manager stays host-agnostic and unit-testable without a
 * `vscode` module; the activation adapter supplies a real panel.
 */
export interface TicketFormPanel {
  reveal(): void;
  postMessage(message: TicketFormHostMessage): void;
  onDidReceiveMessage(handler: (message: unknown) => void | Promise<void>): void;
  /**
   * The panel gained or lost activation (real: `onDidChangeViewState`, reading
   * `e.webviewPanel.active`). `active` is true only when the user is actually
   * on this panel.
   */
  onDidChangeViewState(handler: (active: boolean) => void): void;
  onDidDispose(handler: () => void): void;
  /** Close the tab. Fires `onDidDispose`, which unregisters the panel here. */
  dispose(): void;
  /** Update the tab icon (real: `panel.iconPath = Uri.file(path)`). */
  setIcon(path: string): void;
  /**
   * Convert an absolute filesystem path into a URI this webview may load.
   *
   * Required because only a real `vscode.Webview` can mint one (`asWebviewUri`),
   * while `state.ts` — which produces the paths — is host-agnostic and imports no
   * `vscode`. Same shape as `setIcon(path)`: the manager hands over a path, the
   * adapter knows what to do with it. Test fakes return the path unchanged.
   */
  toWebviewUri(path: string): string;
}

/** Factory the manager uses to mint panels (real: `createWebviewPanel`). */
export interface TicketFormPanelHost {
  createPanel(title: string): TicketFormPanel;
}

/**
 * Context handed to the actions factory: lets an action post results to its
 * webview, re-push fresh state, and know which ticket (edit) or none (create)
 * it is bound to.
 */
export interface TicketFormActionsCtx {
  post(message: TicketFormHostMessage): void;
  pushState(): void;
  /**
   * The bound ticket id, or undefined in create mode until a draft is persisted.
   * A getter (not a fixed value) so `bindTicket` can flip a create panel into
   * edit mode mid-life without re-opening it.
   */
  readonly ticketId?: number;
  readonly mode: 'create' | 'edit';
  /**
   * Host-side picker-touch flag: true once the user has interacted with the
   * approach picker in this form session, never cleared (design, Selection
   * and Enablement). Gates the analyzer's auto-apply — after a touch, later
   * analysis is recommendation-only. The analyzer's own persistence never
   * sets it.
   */
  readonly pickerTouched?: boolean;
  /**
   * Persist-on-fetch hook: bind this (create) panel to a freshly-created draft
   * ticket. After this, `ticketId`/`mode` report edit mode and the next
   * `pushState` seeds from the draft. No-op semantics if already bound.
   */
  bindTicket(id: number): void;
  /**
   * Close this panel — the ticket-form surface is done with the ticket (submit
   * started it, and the dashboard takes over). Idempotent, and everything after
   * it (`post`/`pushState`) becomes a no-op so a late async action can't talk to
   * a disposed webview.
   */
  close(): void;
}

/** Builds the host-side actions for one panel, bound to its ctx. */
export type TicketFormActionsFactory = (ctx: TicketFormActionsCtx) => TicketFormActions;

/**
 * One ticket-form panel per key (§ ticket form). Edit mode keys by ticket id so
 * re-opening reveals rather than duplicates; create mode takes a fresh negative
 * sentinel key per open, since every create request means a new blank page.
 * State is pushed to the webview via postMessage; incoming messages route to
 * injected host actions.
 */
export class TicketFormManager {
  private readonly panels = new Map<number, TicketFormPanel>();
  /** Live ticket binding for every edit or draft-bound create panel. */
  private readonly ticketByPanel = new Map<TicketFormPanel, number>();
  private readonly modelRefreshers = new Set<() => void>();
  /** Next unbound-create sentinel; decrements so create panels never collide. */
  private nextCreateKey = -1;

  /**
   * `manifest` is a getter, not a fixed value, so each open (and each state push
   * after a signal write) reads a fresh manifest — the classify-gate reflects
   * signals just saved to disk.
   */
  constructor(
    private readonly store: Store,
    private readonly manifest: () => Manifest,
    private readonly host: TicketFormPanelHost,
    private readonly actionsFactory: TicketFormActionsFactory,
    /**
     * Returns the ids of approach packages currently installed on disk.
     * Injected so this manager stays host-agnostic (no fs/vscode import) —
     * the real host binds this to `listInstalled(approachesDir).map(id)`.
     * Defaults to "nothing installed" for callers that don't care.
     */
    private readonly listInstalledIds: () => string[] = () => [],
    /**
     * Returns the selectable single-subagent pool (§ single-subagent picker).
     * Injected so this manager stays host-agnostic — the real host binds this
     * to `buildAgentPool({...})`. Defaults to "no agents" for callers that
     * don't care.
     */
    private readonly listAgents: () => PoolAgent[] = () => [],
    /**
     * Whether an interactive session terminal is open for a ticket. Injected so
     * this manager stays host-agnostic — the real host binds it to
     * `SessionManager.isOpen`. Drives the model/effort picker lock (§ B1).
     * Defaults to "never open" for callers that don't care.
     */
    private readonly isSessionOpen: (ticketId: number) => boolean = () => false,
    /** Report a caught pump error to the Karst output channel. */
    private readonly logError: LogError = (m, e) => console.error(m, e),
    /**
     * Resolve a ticket → the file path of its status-tinted tab icon. Called on
     * open and on every state push, so an edit tab tracks the live glyph. An
     * unbound create panel has no ticket yet → no icon.
     */
    private readonly iconFor?: (ticketId: number) => string | undefined,
    /** Current launch-model catalog, refreshed independently of the manifest. */
    private readonly modelCatalog: () => ModelCatalog = bundledModelCatalog,
    /** Global storage root used to construct attachment paths for state pushes. */
    private readonly storageDir?: string,
    /**
     * Reports raw panel activation — including LOSING it — for the ticket the
     * panel is bound to, so the host can track which ticket's view is the
     * window's ACTIVE view (sidebar highlight). A create-mode panel reports
     * nothing until `bindTicket` gives it a ticket. Absent → no report.
     */
    private readonly onViewActivated?: (ticketId: number, active: boolean) => void,
    /**
     * The models most recently used per provider (newest first, ≤5) for the
     * shared picker's "Last used" group. Injected like `modelCatalog` — the
     * host computes it from the append-only token-usage ledger
     * (`store/tokenUsage.ts` `listRecentlyUsedModels`).
     */
    private readonly recentModels: () => Record<string, string[]> = () => ({}),
    /**
     * Base-branch candidates already fetched, keyed by `repoPath` (§ per-repo
     * base branch). A live getter over the SAME cache `buildTicketFormActions`
     * warms lazily (its `setRepos` populates it and calls `pushState`), so a
     * row's candidates appear on the very next state push after selection —
     * never fetched up front for every manifest repository.
     */
    private readonly branchCandidates: () => Record<string, string[]> = () => ({}),
  ) {}

  /**
   * Open a create-mode ticket form. Always a new page: an already-open
   * create panel carries a half-filled (or draft-bound) flow, so revealing it
   * would silently swallow the request for a blank one.
   */
  openCreate(): void {
    this.open(this.nextCreateKey--, 'create', undefined);
  }

  /** Open (or reveal) the edit-mode page for an existing ticket. */
  openEdit(ticketId: number): void {
    this.open(ticketId, 'edit', ticketId);
  }

  private open(key: number, mode: 'create' | 'edit', ticketId?: number): void {
    const existing = this.panels.get(key);
    if (existing) {
      existing.reveal();
      // Focus-taking, like the create path below: `onDidChangeViewState` fires
      // on changes, so the reveal that focused the panel must be reported here.
      if (ticketId !== undefined) this.onViewActivated?.(ticketId, true);
      return;
    }

    // Edit-mode tab title reads as the human ticket label (`key — title`), not
    // the internal SQL id — prefixed with the one-char follow-up marker when
    // the ticket is a follow-up (model/followUp.ts). `ticketId` is always
    // defined in edit mode.
    let title = 'New ticket';
    if (mode === 'edit') {
      const ticket = getTicket(this.store, ticketId!);
      title = compactTicketLabel(ticket, ticketLabel(ticket, this.manifest().ticketLabelTemplate));
    }
    const panel = this.host.createPanel(title);
    this.panels.set(key, panel);
    if (ticketId !== undefined) this.ticketByPanel.set(panel, ticketId);

    // Mutable so persist-on-fetch can bind a create panel to its new draft
    // ticket without re-opening. `pushState`/`ctx` read this live.
    let boundId = ticketId;
    // Host-side picker-touch flag (design, Selection and Enablement): set when
    // the webview posts a user `set-approach`, never cleared for the life of
    // the panel, threaded into every state push and read by the analyzer via
    // ctx. The analyzer's own persistence path never touches this flag.
    let pickerTouched = false;
    // Flipped by dispose (user-closed OR ctx.close). Gates every post so an
    // in-flight action resolving after the tab is gone is silently dropped.
    let disposed = false;
    // The panel's live activation, tracked so `bindTicket` can report a bound
    // create panel that is ALREADY the active view (creation fires no
    // `onDidChangeViewState`, so the flag is the only memory of it).
    let panelActive = false;
    // Mutable alongside `boundId`: a bound create panel is re-keyed to its
    // ticket id, and the dispose handler must drop the key it ended up under.
    let panelKey = key;

    const pushState = (): void => {
      if (disposed) return;
      const state: TicketFormState = buildTicketFormState(
        this.store,
        this.manifest(),
        this.listInstalledIds,
        this.listAgents,
        boundId,
        this.isSessionOpen,
        this.modelCatalog(),
        this.storageDir,
        pickerTouched,
        this.recentModels(),
        this.branchCandidates(),
      );
      // The state builder emits filesystem paths; only the panel can turn one
      // into a URI the webview is allowed to load. Mapped here, at the last
      // moment before the message leaves, so everything upstream stays
      // host-agnostic.
      const withWebviewUris: TicketFormState = {
        ...state,
        attachments: state.attachments.map((a) => ({
          ...a,
          src: panel.toWebviewUri(a.src),
        })),
      };
      panel.postMessage({ type: 'state', state: withWebviewUris });
      // Re-point the tab icon at the bound ticket's live glyph. A create panel
      // stays iconless until `bindTicket` gives it an id.
      const icon = boundId === undefined ? undefined : this.iconFor?.(boundId);
      if (icon) panel.setIcon(icon);
    };
    const ctx: TicketFormActionsCtx = {
      post: (message) => {
        if (!disposed) panel.postMessage(message);
      },
      pushState,
      get ticketId() {
        return boundId;
      },
      get mode() {
        return boundId === undefined ? 'create' : 'edit';
      },
      /**
       * Host-side picker-touch flag, owned by this panel for its whole life
       * (design, Selection and Enablement). Set when the webview posts a user
       * `set-approach` — the ONLY way a user touches the picker — and never
       * cleared, so the analyzer's auto-pick is gated for the session.
       */
      get pickerTouched() {
        return pickerTouched;
      },
      bindTicket: (id: number) => {
        boundId = id;
        this.ticketByPanel.set(panel, id);
        // Once bound, this panel IS the ticket's edit panel — re-key it so
        // `openEdit(id)` reveals it rather than opening a second one. If an
        // edit panel for that ticket already exists, leave the keys alone.
        if (panelKey !== id && !this.panels.has(id)) {
          this.panels.delete(panelKey);
          this.panels.set(id, panel);
          panelKey = id;
        }
        // A create panel bound mid-life is the ticket's ACTIVE view if it was
        // created focus-taking and the user never moved away — creation fires
        // no view-state event, so the tracked flag is the only way to know.
        if (panelActive) this.onViewActivated?.(id, true);
      },
      close: () => {
        if (disposed) return;
        panel.dispose();
      },
    };
    this.modelRefreshers.add(pushState);
    const actions = this.actionsFactory(ctx);

    panel.onDidReceiveMessage((raw) => {
      // Read the correlation id off the RAW message, before it is narrowed —
      // `parseTicketFormMessage` deliberately drops fields it does not model,
      // and that dropping is the trust boundary (see readRequestId's own doc).
      const requestId = readRequestId(raw);
      // An unparsed message posts NOTHING (UI-R13): no action ran, so there is
      // no terminal outcome to report.
      if (!parseTicketFormMessage(raw)) return;
      // A USER touched the approach picker. The analyzer's own persist path
      // calls `setApproach` host-side and never passes through this pump, so
      // this is the ONLY source of the touch flag — and once set, no later
      // analysis may auto-apply (design, Selection and Enablement).
      if ((raw as { type?: string }).type === 'set-approach') pickerTouched = true;
      void reportAction(requestId, (message) => ctx.post(message), () => {
        // The message pump must never die on one bad message — log it either
        // way, then rethrow so reportAction reports the real failure as
        // `ok:false` rather than a silent ack. Several actions here (fetch,
        // suggest, analyze, submit, save) already self-report their own
        // outcome via `busy`/`error` posts and carry no `requestId`, so this
        // legacy fallback only fires for a request that opted OUT of the new
        // `action-result` contract — preserving the pre-existing behaviour of
        // an unconditional `{type:'error'}` post for those.
        try {
          const result = routeTicketFormAction(raw, actions);
          if (result && typeof (result as PromiseLike<void>).then === 'function') {
            return (result as Promise<void>).catch((err: unknown) => {
              this.logError('karst: ticket-form action failed', err);
              if (requestId === undefined) {
                ctx.post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
              }
              throw err;
            });
          }
          return result;
        } catch (err) {
          this.logError('karst: ticket-form action failed', err);
          if (requestId === undefined) {
            ctx.post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
          }
          throw err;
        }
      });
    });
    // Live `boundId` is read at report time: a create panel flipped into edit
    // mode via `bindTicket` becomes its ticket's edit view mid-life, and a
    // still-unbound create panel has no ticket to highlight.
    panel.onDidChangeViewState((active) => {
      panelActive = active;
      if (boundId !== undefined) this.onViewActivated?.(boundId, active);
    });
    panel.onDidDispose(() => {
      disposed = true;
      this.panels.delete(panelKey);
      this.ticketByPanel.delete(panel);
      this.modelRefreshers.delete(pushState);
      // The ACTIVE view can be closed while focused; the dispose is the only
      // signal that the focus is gone, so report it exactly like a deactivation.
      if (boundId !== undefined) this.onViewActivated?.(boundId, false);
    });

    pushState();
    // Creation focuses the panel, and `onDidChangeViewState` fires on changes,
    // not on the initial activation — report it so the sidebar highlights it
    // (a create panel reports nothing until it has a ticket).
    panelActive = true;
    if (boundId !== undefined) this.onViewActivated?.(boundId, true);
  }

  /** Push the current catalog to every ticket-form panel that is still live. */
  refreshModels(): void {
    for (const refresh of this.modelRefreshers) refresh();
  }

  /**
   * Dispose every local ticket-form panel bound to a ticket being hard-deleted.
   * Snapshot first because `dispose()` synchronously unregisters the panel.
   */
  closeTicket(ticketId: number): void {
    for (const [panel, boundId] of [...this.ticketByPanel]) {
      if (boundId === ticketId) panel.dispose();
    }
  }

  /**
   * Whether any unbound create-mode panel is currently open (for the
   * caller/tests). Create panels live under the negative sentinel keys.
   */
  isCreateOpen(): boolean {
    return [...this.panels.keys()].some((k) => k < 0);
  }
}
