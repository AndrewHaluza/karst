import type { Store } from '../../store/db.js';
import { getTicket, ticketLabel } from '../../store/tickets.js';
import type { Manifest } from '../../manifest/types.js';
import type { PoolAgent } from '../../agents/pool.js';
import type { LogError } from '../../logging/logger.js';
import { buildOnboardingState, type OnboardingState } from './state.js';
import {
  routeOnboardingAction,
  type OnboardingActions,
  type OnboardingHostMessage,
} from './messages.js';
import {
  bundledModelCatalog,
  type ModelCatalog,
} from '../../agent/modelCatalog.js';

/**
 * The subset of a `vscode.WebviewPanel` the onboarding manager touches. Modeled
 * as an interface so the manager stays host-agnostic and unit-testable without a
 * `vscode` module; the activation adapter supplies a real panel.
 */
export interface OnboardingPanel {
  reveal(): void;
  postMessage(message: OnboardingHostMessage): void;
  onDidReceiveMessage(handler: (message: unknown) => void): void;
  onDidDispose(handler: () => void): void;
  /** Close the tab. Fires `onDidDispose`, which unregisters the panel here. */
  dispose(): void;
  /** Update the tab icon (real: `panel.iconPath = Uri.file(path)`). */
  setIcon(path: string): void;
}

/** Factory the manager uses to mint panels (real: `createWebviewPanel`). */
export interface OnboardingPanelHost {
  createPanel(title: string): OnboardingPanel;
}

/**
 * Context handed to the actions factory: lets an action post results to its
 * webview, re-push fresh state, and know which ticket (edit) or none (create)
 * it is bound to.
 */
export interface OnboardingActionsCtx {
  post(message: OnboardingHostMessage): void;
  pushState(): void;
  /**
   * The bound ticket id, or undefined in create mode until a draft is persisted.
   * A getter (not a fixed value) so `bindTicket` can flip a create panel into
   * edit mode mid-life without re-opening it.
   */
  readonly ticketId?: number;
  readonly mode: 'create' | 'edit';
  /**
   * Persist-on-fetch hook: bind this (create) panel to a freshly-created draft
   * ticket. After this, `ticketId`/`mode` report edit mode and the next
   * `pushState` seeds from the draft. No-op semantics if already bound.
   */
  bindTicket(id: number): void;
  /**
   * Close this panel — the onboarding surface is done with the ticket (submit
   * started it, and the dashboard takes over). Idempotent, and everything after
   * it (`post`/`pushState`) becomes a no-op so a late async action can't talk to
   * a disposed webview.
   */
  close(): void;
}

/** Builds the host-side actions for one panel, bound to its ctx. */
export type OnboardingActionsFactory = (ctx: OnboardingActionsCtx) => OnboardingActions;

/**
 * One onboarding panel per key (§ onboarding). Edit mode keys by ticket id so
 * re-opening reveals rather than duplicates; create mode takes a fresh negative
 * sentinel key per open, since every create request means a new blank page.
 * State is pushed to the webview via postMessage; incoming messages route to
 * injected host actions.
 */
export class OnboardingManager {
  private readonly panels = new Map<number, OnboardingPanel>();
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
    private readonly host: OnboardingPanelHost,
    private readonly actionsFactory: OnboardingActionsFactory,
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
    /** Report a caught pump error to the Karst output channel (§ todo-5). */
    private readonly logError: LogError = (m, e) => console.error(m, e),
    /**
     * Resolve a ticket → the file path of its status-tinted tab icon. Called on
     * open and on every state push, so an edit tab tracks the live glyph. An
     * unbound create panel has no ticket yet → no icon.
     */
    private readonly iconFor?: (ticketId: number) => string | undefined,
    /** Current launch-model catalog, refreshed independently of the manifest. */
    private readonly modelCatalog: () => ModelCatalog = bundledModelCatalog,
  ) {}

  /**
   * Open a create-mode onboarding page. Always a new page: an already-open
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
      return;
    }

    // Edit-mode tab title reads as the human ticket label (`key — title`), not
    // the internal SQL id. `ticketId` is always defined in edit mode.
    const title =
      mode === 'create'
        ? 'New ticket'
        : ticketLabel(getTicket(this.store, ticketId!), this.manifest().ticketLabelTemplate);
    const panel = this.host.createPanel(title);
    this.panels.set(key, panel);

    // Mutable so persist-on-fetch can bind a create panel to its new draft
    // ticket without re-opening. `pushState`/`ctx` read this live.
    let boundId = ticketId;
    // Flipped by dispose (user-closed OR ctx.close). Gates every post so an
    // in-flight action resolving after the tab is gone is silently dropped.
    let disposed = false;
    // Mutable alongside `boundId`: a bound create panel is re-keyed to its
    // ticket id, and the dispose handler must drop the key it ended up under.
    let panelKey = key;

    const pushState = (): void => {
      if (disposed) return;
      const state: OnboardingState = buildOnboardingState(
        this.store,
        this.manifest(),
        this.listInstalledIds,
        this.listAgents,
        boundId,
        this.isSessionOpen,
        this.modelCatalog(),
      );
      panel.postMessage({ type: 'state', state });
      // Re-point the tab icon at the bound ticket's live glyph. A create panel
      // stays iconless until `bindTicket` gives it an id.
      const icon = boundId === undefined ? undefined : this.iconFor?.(boundId);
      if (icon) panel.setIcon(icon);
    };
    const ctx: OnboardingActionsCtx = {
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
      bindTicket: (id: number) => {
        boundId = id;
        // Once bound, this panel IS the ticket's edit panel — re-key it so
        // `openEdit(id)` reveals it rather than opening a second one. If an
        // edit panel for that ticket already exists, leave the keys alone.
        if (panelKey !== id && !this.panels.has(id)) {
          this.panels.delete(panelKey);
          this.panels.set(id, panel);
          panelKey = id;
        }
      },
      close: () => {
        if (disposed) return;
        panel.dispose();
      },
    };
    this.modelRefreshers.add(pushState);
    const actions = this.actionsFactory(ctx);

    panel.onDidReceiveMessage((raw) => {
      try {
        routeOnboardingAction(raw, actions);
      } catch (err) {
        // The message pump must never die on one bad message.
        this.logError('karst: onboarding action failed', err);
      }
    });
    panel.onDidDispose(() => {
      disposed = true;
      this.panels.delete(panelKey);
      this.modelRefreshers.delete(pushState);
    });

    pushState();
  }

  /** Push the current catalog to every onboarding panel that is still live. */
  refreshModels(): void {
    for (const refresh of this.modelRefreshers) refresh();
  }

  /**
   * Whether any unbound create-mode panel is currently open (for the
   * caller/tests). Create panels live under the negative sentinel keys.
   */
  isCreateOpen(): boolean {
    return [...this.panels.keys()].some((k) => k < 0);
  }
}
