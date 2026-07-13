import type { Store } from '../../store/db.js';
import { getTicket, ticketLabel } from '../../store/tickets.js';
import type { Manifest } from '../../manifest/types.js';
import type { PoolAgent } from '../../agents/pool.js';
import { buildOnboardingState, type OnboardingState } from './state.js';
import {
  routeOnboardingAction,
  type OnboardingActions,
  type OnboardingHostMessage,
} from './messages.js';

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
}

/** Builds the host-side actions for one panel, bound to its ctx. */
export type OnboardingActionsFactory = (ctx: OnboardingActionsCtx) => OnboardingActions;

/** Sentinel key for the single create-mode panel (no ticket id yet). */
const CREATE_KEY = -1;

/**
 * One onboarding panel per key (§ onboarding). Create mode uses a single
 * sentinel panel; edit mode keys by ticket id so re-opening reveals rather than
 * duplicates. State is pushed to the webview via postMessage; incoming messages
 * route to injected host actions.
 */
export class OnboardingManager {
  private readonly panels = new Map<number, OnboardingPanel>();

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
  ) {}

  /** Open (or reveal) the create-mode onboarding page. */
  openCreate(): void {
    this.open(CREATE_KEY, 'create', undefined);
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

    const pushState = (): void => {
      const state: OnboardingState = buildOnboardingState(
        this.store,
        this.manifest(),
        this.listInstalledIds,
        this.listAgents,
        boundId,
        this.isSessionOpen,
      );
      panel.postMessage({ type: 'state', state });
    };
    const ctx: OnboardingActionsCtx = {
      post: (message) => panel.postMessage(message),
      pushState,
      get ticketId() {
        return boundId;
      },
      get mode() {
        return boundId === undefined ? 'create' : 'edit';
      },
      bindTicket: (id: number) => {
        boundId = id;
      },
    };
    const actions = this.actionsFactory(ctx);

    panel.onDidReceiveMessage((raw) => {
      try {
        routeOnboardingAction(raw, actions);
      } catch (err) {
        // The message pump must never die on one bad message.
        console.error('karst: onboarding action failed', err);
      }
    });
    panel.onDidDispose(() => this.panels.delete(key));

    pushState();
  }

  /** Whether a create-mode panel is currently open (for the caller/tests). */
  isCreateOpen(): boolean {
    return this.panels.has(CREATE_KEY);
  }
}
