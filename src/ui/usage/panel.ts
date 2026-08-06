import type { Store } from '../../store/db.js';
import type { LogError } from '../../logging/logger.js';
import { buildUsageState, type UsageState } from './state.js';
import {
  parseUsageMessage,
  routeUsageAction,
  type UsageActions,
  type UsageHostMessage,
  type UsageWebviewMessage,
} from './messages.js';
import {
  DEFAULT_USAGE_LIMIT,
  DEFAULT_USAGE_RANGE,
  type UsageSort,
} from '../../store/tokenUsageQuery.js';
import { readRequestId, reportAction } from '../../model/actionResult.js';

/**
 * The token-usage panel (§ token consumption stats) — ONE per window, unlike the
 * per-ticket dashboard, because the view's subject is the project's whole spend.
 * Opening it again reveals the existing panel rather than minting a second one
 * that would drift out of sync with it.
 *
 * The filter state (range, sort, page) lives HERE, not in the webview, for the
 * same reason the dashboard's terminal binding does: the host is what queries,
 * so if the webview held the selection the two could disagree about which range
 * the numbers on screen belong to. The webview posts intent and renders what it
 * is pushed.
 */

/** The subset of a `vscode.WebviewPanel` this manager touches. */
export interface UsagePanel {
  reveal(preserveFocus?: boolean): void;
  postMessage(message: UsageHostMessage): void;
  onDidReceiveMessage(handler: (message: unknown) => void): void;
  onDidDispose(handler: () => void): void;
}

/** Factory the manager mints panels with (real: `createWebviewPanel`). */
export interface UsagePanelHost {
  createPanel(title: string): UsagePanel;
}

export interface UsagePanelDeps {
  /** The window's bound project — a getter, since binding resolves at activation. */
  projectId?: () => number | undefined;
  /** Open a ticket's dashboard from a row in the per-ticket table. */
  openDashboard?: (ticketId: number) => void;
  logError?: LogError;
  /** Injected clock; the rolling ranges are relative to it. */
  now?: () => Date;
}

export class UsagePanelManager {
  private panel: UsagePanel | undefined;
  private rangeId: string = DEFAULT_USAGE_RANGE;
  private sort: UsageSort = 'total';
  private offset = 0;

  constructor(
    private readonly store: Store,
    private readonly host: UsagePanelHost,
    private readonly deps: UsagePanelDeps = {},
  ) {}

  /** Open (or reveal) the panel. Idempotent — never a second panel. */
  open(): void {
    if (this.panel) {
      this.panel.reveal();
      this.push();
      return;
    }
    const panel = this.host.createPanel('Token usage');
    this.panel = panel;
    panel.onDidDispose(() => {
      this.panel = undefined;
    });
    panel.onDidReceiveMessage((raw) => {
      // The requestId is read off the RAW message, before parsing narrows it
      // away (parseUsageMessage deliberately drops every field it does not
      // model). `reportAction` never rejects, so the message pump is safe by
      // construction; an unparsed message posts nothing (UI-R13).
      const requestId = readRequestId(raw);
      const msg = parseUsageMessage(raw);
      if (!msg) return;
      const actions = this.actions();
      void reportAction(requestId, (m) => panel.postMessage(m), () => this.runAction(msg, actions));
    });
    this.push();
  }

  /** Re-read and re-push. Safe (a no-op) when the panel is closed. */
  refresh(): void {
    this.push();
  }

  /** The state the panel would render right now — the read the tests assert on. */
  state(): UsageState {
    return buildUsageState(this.store, {
      projectId: this.deps.projectId?.() ?? null,
      rangeId: this.rangeId,
      sort: this.sort,
      offset: this.offset,
      limit: DEFAULT_USAGE_LIMIT,
      ...(this.deps.now ? { now: this.deps.now } : {}),
    });
  }

  private actions(): UsageActions {
    return {
      requestState: () => this.push(),
      setRange: (range) => {
        this.rangeId = range;
        // A new range has a different number of ticket groups, so the old page
        // offset can point past the end. Start over rather than show a blank page.
        this.offset = 0;
        this.push();
      },
      setSort: (sort) => {
        this.sort = sort;
        this.offset = 0;
        this.push();
      },
      setPage: (offset) => {
        this.offset = offset;
        this.push();
      },
      openDashboard: (ticketId) => this.deps.openDashboard?.(ticketId),
    };
  }

  private push(): void {
    if (!this.panel) return;
    try {
      this.panel.postMessage({ type: 'state', state: this.state() });
    } catch (err) {
      this.log('karst: token-usage push failed', err);
    }
  }

  /** Dispatch one parsed message, logging (but still surfacing) any failure. */
  private runAction(msg: UsageWebviewMessage, actions: UsageActions): void | Promise<void> {
    try {
      const result = routeUsageAction(msg, actions);
      if (result && typeof (result as PromiseLike<void>).then === 'function') {
        return (result as Promise<void>).catch((err: unknown) => {
          this.log('karst: token-usage action failed', err);
          throw err;
        });
      }
      return result;
    } catch (err) {
      this.log('karst: token-usage action failed', err);
      throw err;
    }
  }

  private log(message: string, err: unknown): void {
    (this.deps.logError ?? ((m: string, e: unknown) => console.error(m, e)))(message, err);
  }
}
