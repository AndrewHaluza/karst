import type { RestoredPanel } from '../shared/restoredPanel.js';
import type { Store } from '../../store/db.js';
import type { LogError } from '../../logging/logger.js';
import { buildUsageState, usageErrorState, type UsageState, type UsageTab } from './state.js';
import type { AgentProvider } from '../../manifest/types.js';
import type { QuotaSnapshot } from '../../agent/quota/types.js';
import {
  isUsageTab,
  parseUsageMessage,
  routeUsageAction,
  type UsageActions,
  type UsageHostMessage,
  type UsageWebviewMessage,
} from './messages.js';
import {
  DEFAULT_USAGE_LIMIT,
  type UsageSort,
} from '../../store/tokenUsageQuery.js';
import { readRequestId, reportAction } from '../../model/actionResult.js';

/**
 * The token-usage panel (§ token consumption stats) — ONE per window, unlike the
 * per-ticket dashboard, because the view's subject is the project's whole spend.
 * Opening it again reveals the existing panel rather than minting a second one
 * that would drift out of sync with it.
 *
 * The filter state (sort, page) lives HERE, not in the webview, for the
 * same reason the dashboard's terminal binding does: the host is what queries,
 * so if the webview held the selection the two could disagree about which range
 * the numbers on screen belong to. The webview posts intent and renders what it
 * is pushed.
 */

/** One recorded token delta coalesces into at most one re-read per second (US-11). */
export const USAGE_REFRESH_DEBOUNCE_MS = 1000;

/** The user-facing text for a host read failure (US-2); never the exception. */
export const USAGE_READ_FAILED_TEXT = 'Could not read token usage. Details are in the Karst log.';

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
  openDashboard?: (ticketId: number) => void | Promise<void>;
  /** Cached per-core quota snapshots — the quota tab's data. */
  quota?: () => readonly QuotaSnapshot[];
  /** The manifest's quota warn threshold. */
  quotaThresholdPct?: () => number;
  /** Active account name of a core when not 'default' (the quota tab shows it). */
  quotaAccountOf?: (core: AgentProvider) => string | undefined;
  /** Open Settings on the quota/accounts section (US-13). */
  openQuotaSettings?: () => void | Promise<void>;
  /** Open the new-ticket form from the empty state (US-15). */
  createTicket?: () => void | Promise<void>;
  /** Re-read quota from the provider (US-31). */
  refreshQuota?: () => void | Promise<void>;
  logError?: LogError;
  /** Injected clock; the rolling ranges are relative to it. */
  now?: () => Date;
}

export class UsagePanelManager {
  private panel: UsagePanel | undefined;
  private tab: UsageTab = 'spend';
  private sort: UsageSort = 'total';
  private offset = 0;
  /** The pending debounced refresh, if any (US-11). */
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly store: Store,
    private readonly host: UsagePanelHost,
    private readonly deps: UsagePanelDeps = {},
  ) {}

  /** Open (or reveal) the panel. Idempotent — never a second panel. */
  open(tab: UsageTab = 'spend'): void {
    this.tab = tab;
    if (this.panel) {
      this.panel.reveal();
      this.push();
      return;
    }
    this.start(this.host.createPanel('Token usage'));
  }

  /**
   * Adopt the tab VS Code restored after a reload; a duplicate is closed. Never reveals.
   * The webview state is the reload carrier for the selected tab; anything but a
   * known tab id gives 'spend'. The tab is set before start(), so the first push has it.
   */
  adopt(restored: RestoredPanel<UsagePanel>, state?: unknown): boolean {
    if (this.panel) {
      restored.dispose();
      return false;
    }
    const tab = typeof state === 'object' && state !== null ? (state as { tab?: unknown }).tab : undefined;
    this.tab = isUsageTab(tab) ? tab : 'spend';
    this.start(restored.wrap());
    return true;
  }

  private start(panel: UsagePanel): void {
    this.panel = panel;
    panel.onDidDispose(() => {
      this.clearRefreshTimer();
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

  /**
   * Coalesce a burst of recorded rows into one re-read (US-11). A no-op while
   * the panel is closed — a later open reads fresh state anyway.
   */
  scheduleRefresh(delayMs: number = USAGE_REFRESH_DEBOUNCE_MS): void {
    if (!this.panel) return;
    this.clearRefreshTimer();
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      this.refresh();
    }, delayMs);
  }

  /** Drop the pending debounce; safe to call twice. */
  dispose(): void {
    this.clearRefreshTimer();
  }

  private clearRefreshTimer(): void {
    if (this.refreshTimer !== undefined) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = undefined;
    }
  }

  /** The state the panel would render right now — the read the tests assert on. */
  state(): UsageState {
    return buildUsageState(this.store, {
      projectId: this.deps.projectId?.() ?? null,
      tab: this.tab,
      sort: this.sort,
      offset: this.offset,
      limit: DEFAULT_USAGE_LIMIT,
      quota: this.deps.quota?.() ?? [],
      ...(this.deps.quotaAccountOf ? { quotaAccountOf: this.deps.quotaAccountOf } : {}),
      ...(this.deps.quotaThresholdPct ? { quotaThresholdPct: this.deps.quotaThresholdPct() } : {}),
      ...(this.deps.now ? { now: this.deps.now } : {}),
    });
  }

  private actions(): UsageActions {
    return {
      requestState: () => this.push(),
      setTab: (tab) => {
        this.tab = tab;
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
      openQuotaSettings: () => this.deps.openQuotaSettings?.(),
      createTicket: () => this.deps.createTicket?.(),
      refreshQuota: () => this.deps.refreshQuota?.(),
    };
  }

  private push(): void {
    if (!this.panel) return;
    try {
      this.panel.postMessage({ type: 'state', state: this.state() });
    } catch (err) {
      this.log('karst: token-usage push failed', err);
      // A thrown read must never leave the webview on a blank frame (US-2):
      // post the shell with one actionable sentence and a way to retry.
      try {
        const state = usageErrorState(
          { tab: this.tab, sort: this.sort, offset: this.offset, limit: DEFAULT_USAGE_LIMIT },
          USAGE_READ_FAILED_TEXT,
          this.deps.now?.(),
        );
        this.panel.postMessage({ type: 'state', state });
      } catch (postErr) {
        this.log('karst: token-usage error-state push failed', postErr);
      }
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
