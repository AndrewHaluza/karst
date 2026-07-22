import type { Store } from '../../store/db.js';
import type { LogError } from '../../logging/logger.js';
import { buildSidebarState } from './state.js';
import {
  routeSidebarAction,
  type SidebarActions,
  type SidebarHostMessage,
} from './messages.js';
import {
  toggleFacet,
  normalizeSelection,
  DEFAULT_SELECTION,
  type FacetKey,
  type FacetSelection,
} from './facets.js';
import type { PathContext } from '../worktreePath.js';

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
  ) {}

  /** Bind the manager to a view host; wires resolve → initial push + routing. */
  bind(host: SidebarViewHost): void {
    const actions = this.actionsFactory(this);
    host.onResolve((view) => {
      this.view = view;
      view.onDidReceiveMessage((raw) => {
        try {
          routeSidebarAction(raw, actions);
        } catch (err) {
          // The message pump must never die on one bad message.
          this.logError('karst: sidebar action failed', err);
        }
      });
      this.push();
    });
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
        projectId: this.projectId?.(),
      },
      this.pathContext?.(),
    );
    this.view.postMessage({ type: 'state', state });
  }

  /** Re-query and re-push. Named to match the old tree provider's `refresh`. */
  refresh(): void {
    this.push();
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
