import type { Store } from '../../store/db.js';
import type { AgentProvider } from '../../manifest/types.js';
import type { LogError } from '../../logging/logger.js';
import { buildSidebarState } from './state.js';
import {
  parseSidebarMessage,
  routeSidebarAction,
  type SidebarActions,
  type SidebarHostMessage,
  type SidebarWebviewMessage,
} from './messages.js';
import {
  toggleFacet,
  normalizeSelection,
  DEFAULT_SELECTION,
  type FacetKey,
  type FacetSelection,
} from './facets.js';
import type { PathContext } from '../worktreePath.js';
import { readRequestId, reportAction } from '../../model/actionResult.js';

/**
 * The subset of a `vscode.WebviewView` the manager touches. Modeled as an
 * interface so `SidebarViewManager` stays host-agnostic and unit-testable
 * without a `vscode` module; the activation adapter supplies a real view.
 */
export interface SidebarView {
  postMessage(message: SidebarHostMessage): void;
  onDidReceiveMessage(handler: (message: unknown) => void): void;
}

/** Factory the manager binds to (real: `registerWebviewViewProvider`). */
export interface SidebarViewHost {
  /** Called by the host when the view is resolved; hands us the live view. */
  onResolve(handler: (view: SidebarView) => void): void;
}

/**
 * Sidebar ticket-list manager (replaces the native `KarstTreeProvider`). Holds
 * the current facet + filter and re-pushes serialized state to the webview on
 * every `refresh`/`setFilter`/`toggleFacet` — the SAME method names the extension's
 * existing call sites used on the tree provider, so those call sites are
 * unchanged. Inbound webview messages route to injected `SidebarActions`.
 *
 * The view can resolve/dispose as VS Code shows/hides the sidebar; a push before
 * the first resolve is a safe no-op, and the webview re-requests state on load.
 */
export class SidebarViewManager {
  private view: SidebarView | undefined;
  private facets: FacetKey[] = [...DEFAULT_SELECTION];
  private filter = '';
  private refreshSubscriber: (() => void) | undefined;

  constructor(
    private readonly store: Store,
    private readonly actionsFactory: (mgr: SidebarViewManager) => SidebarActions,
    /** Live worktree-path display context (honors manifest `worktreePathDisplay`). */
    private readonly pathContext?: () => PathContext | undefined,
    /** Live ticket-label template getter (honors manifest `ticketLabelTemplate`). */
    private readonly labelTemplate?: () => string | undefined,
    /** Report a caught pump error to the Karst output channel (§ todo-5). */
    private readonly logError: LogError = (m, e) => console.error(m, e),
    /**
     * The window's bound project (§ projects / multi-window). A getter, not a
     * value, because binding happens during activation and can re-resolve when
     * the manifest reloads — the sidebar must never cache a stale project id.
     */
    private readonly projectId?: () => number | undefined,
    /** Live manifest agent core, so the session verb previews the real launch. */
    private readonly defaultProvider?: () => AgentProvider | undefined,
  ) {}

  /** Bind the manager to a view host; wires resolve → initial push + routing. */
  bind(host: SidebarViewHost): void {
    const actions = this.actionsFactory(this);
    host.onResolve((view) => {
      this.view = view;
      view.onDidReceiveMessage((raw) => {
        // The requestId is read off the RAW message, before parsing narrows it
        // away (parseSidebarMessage deliberately drops every field it does not
        // model). `reportAction` never rejects, so the message pump is safe by
        // construction; an unparsed message posts nothing (UI-R13).
        const requestId = readRequestId(raw);
        const msg = parseSidebarMessage(raw);
        if (!msg) return;
        void reportAction(requestId, (m) => view.postMessage(m), () => this.runAction(msg, actions));
      });
      this.push();
    });
  }

  /** Dispatch one parsed message, logging (but still surfacing) any failure. */
  private runAction(msg: SidebarWebviewMessage, actions: SidebarActions): void | Promise<void> {
    try {
      const result = routeSidebarAction(msg, actions);
      if (result && typeof (result as PromiseLike<void>).then === 'function') {
        return (result as Promise<void>).catch((err: unknown) => {
          this.logError('karst: sidebar action failed', err);
          throw err;
        });
      }
      return result;
    } catch (err) {
      this.logError('karst: sidebar action failed', err);
      throw err;
    }
  }

  /** Re-read the store and push a fresh state snapshot; no-op before resolve. */
  private push(): void {
    if (!this.view) return;
    const state = buildSidebarState(
      this.store,
      {
        facets: this.facets,
        filter: this.filter,
        labelTemplate: this.labelTemplate?.(),
        defaultProvider: this.defaultProvider?.(),
        projectId: this.projectId?.(),
      },
      this.pathContext?.(),
    );
    this.view.postMessage({ type: 'state', state });
  }

  /** Re-query and re-push. Named to match the old tree provider's `refresh`. */
  refresh(): void {
    this.push();
    this.refreshSubscriber?.();
  }

  /**
   * Observe every `refresh` — the ticket-set-changed signal, which is what the
   * activity-bar badge and the attention status item are derived from.
   *
   * Deliberately NOT fired by `setFilter`/`toggleFacet`: those change what this
   * view SHOWS, not which tickets need the user.
   *
   * One subscriber, last registration wins — the same contract
   * `SidebarViewHost.onResolve` already has. This is wiring, not an event bus.
   */
  onRefresh(cb: () => void): void {
    this.refreshSubscriber = cb;
  }

  /** Set the search filter and re-push; blank clears it. */
  setFilter(query: string): void {
    this.filter = query;
    this.push();
  }

  /** Toggle one facet chip in the multi-select selection and re-push. */
  toggleFacet(facet: FacetKey): void {
    this.facets = toggleFacet(this.facets, facet);
    this.push();
  }

  /** Replace the whole selection (e.g. the multi-pick command) and re-push. */
  setFacets(facets: FacetSelection): void {
    this.facets = normalizeSelection(facets);
    this.push();
  }

  /** The active selection (for the filterState command to mark current picks). */
  getFacets(): FacetKey[] {
    return this.facets;
  }
}
