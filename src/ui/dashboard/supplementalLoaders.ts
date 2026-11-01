import type { LogError } from '../../logging/logger.js';
import type { WorktreeView } from '../../store/dashboard.js';
import type { BranchCandidatesLoader, DashboardPanel } from './panelTypes.js';
import type { DashboardState } from './state.js';
import type { GateOptions, GateOptionsLoader, GateRunOrderEntry } from './gateOptions.js';
import type { WorktreeStatsLoader } from './worktreeStats.js';
import type { BaselineReviewRow, BaselineRowsLoader } from './baselineRows.js';
import type { StoredArtifactsView } from './storedArtifacts.js';
import type { ShipPreview, ShipPreviewLoader } from '../../workflow/shipPreview.js';

/** Read the ticket's stored-artifact view (T2 store); may reject. */
export type StoredArtifactsLoader = (ticketId: number) => Promise<StoredArtifactsView>;

/** Content equality for `GateOptions` — a fresh resolution is a new object every time. */
function sameGateOptions(a: GateOptions, b: GateOptions): boolean {
  return (
    sameOptions(a.uat, b.uat) &&
    sameOptions(a.review, b.review) &&
    sameRunOrder(a.runOrder?.uat, b.runOrder?.uat) &&
    sameRunOrder(a.runOrder?.review, b.runOrder?.review)
  );
}

function sameRunOrder(
  a: readonly GateRunOrderEntry[] | undefined,
  b: readonly GateRunOrderEntry[] | undefined,
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.length === b.length &&
    a.every((x, i) => x.name === b[i]!.name && x.repo === b[i]!.repo && x.disabled === b[i]!.disabled)
  );
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

/** What the loaders need back from the manager they supplement. */
export interface SupplementalHost {
  /** Is `panel` still the live panel for `ticketId`? (Guards a late async post.) */
  isCurrentPanel(ticketId: number, panel: DashboardPanel): boolean;
  /**
   * Re-push a snapshot after supplemental news. `settlesActions` selects
   * `pushState` (true) vs `pushPassiveState` (false) — the exact authority the
   * originating snapshot carried.
   */
  repush(ticketId: number, settlesActions: boolean): void;
}

/**
 * The dashboard's supplemental async loaders, apart from the synchronous store
 * snapshot: worktree Git totals, resolved gate names, and base-branch
 * candidates. Each answers a question that changes when the WORKTREE or the
 * MANIFEST changes, not when a gate advances a second — so they never ride the
 * per-tick repaint, and every one aborts its predecessor so a slower earlier
 * probe can never overwrite a newer answer.
 *
 * `branchCandidates` is keyed by repoPath, NOT by ticket: a repo's git listing
 * does not vary by ticket, so the cache is shared across every open panel and
 * survives a panel close.
 */
export class SupplementalLoaders {
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
  /**
   * Base-branch candidates per repoPath, warmed lazily by
   * `prefetchBranchCandidates` and shared across every open ticket. A repoPath
   * absent from the map has not been fetched yet — `[]` in state until then,
   * never a host round trip the webview waits on.
   */
  private readonly branchCandidates = new Map<string, string[]>();
  /** The last baseline rows per ticket (@arch:BASELINE-REVIEW); dies with the panel. */
  private readonly baselineCache = new Map<number, BaselineReviewRow[]>();
  private readonly baselineRequests = new Map<number, number>();
  /** The last stored-artifact view per ticket; dies with the panel. */
  private readonly storedCache = new Map<number, StoredArtifactsView>();
  private readonly storedRequests = new Map<number, number>();
  /** The last keyboard-advisory ship preview per ticket; dies with the panel. */
  private readonly shipPreviewCache = new Map<number, ShipPreview>();
  private readonly shipPreviewRequests = new Map<number, number>();
  private readonly shipPreviewControllers = new Map<number, AbortController>();

  constructor(
    private readonly loadStats: WorktreeStatsLoader | undefined,
    private readonly loadGateOptions: GateOptionsLoader | undefined,
    private readonly loadBranchCandidates: BranchCandidatesLoader | undefined,
    private readonly logError: LogError,
    private readonly loadBaselines?: BaselineRowsLoader,
    private readonly loadStoredArtifacts?: StoredArtifactsLoader,
    private readonly loadShipPreview?: ShipPreviewLoader,
  ) {}

  /** The last resolved gate options for a ticket, if any. */
  gateOptionsFor(ticketId: number): GateOptions | undefined {
    return this.gateOptionsCache.get(ticketId);
  }

  /** The last loaded baseline rows for a ticket; `[]` until the first load answers. */
  baselinesFor(ticketId: number): BaselineReviewRow[] {
    return this.baselineCache.get(ticketId) ?? [];
  }

  /**
   * Load the ticket's changed-baseline rows for THIS panel (its URIs are minted
   * per webview) and re-push only when they changed — otherwise every follow-up
   * would trigger the next. Only the latest request for a live panel may land.
   */
  pushBaselines(
    ticketId: number,
    panel: DashboardPanel,
    settlesActions: boolean,
    host: SupplementalHost,
  ): void {
    if (!this.loadBaselines) return;
    const request = (this.baselineRequests.get(ticketId) ?? 0) + 1;
    this.baselineRequests.set(ticketId, request);
    void this.loadBaselines(ticketId, (path) => panel.asWebviewUri?.(path) ?? path).then(
      (rows) => {
        if (!host.isCurrentPanel(ticketId, panel)) return;
        if (this.baselineRequests.get(ticketId) !== request) return;
        const previous = this.baselinesFor(ticketId);
        this.baselineCache.set(ticketId, rows);
        if (JSON.stringify(previous) !== JSON.stringify(rows)) host.repush(ticketId, settlesActions);
      },
      (error) => {
        if (!host.isCurrentPanel(ticketId, panel)) return;
        if (this.baselineRequests.get(ticketId) !== request) return;
        this.logError('karst: dashboard baseline review rows failed', error);
      },
    );
  }

  /** The last loaded stored-artifact view; undefined until the first load answers. */
  storedArtifactsFor(ticketId: number): StoredArtifactsView | undefined {
    return this.storedCache.get(ticketId);
  }

  /** Reload the stored-artifact view; re-push only when it changed. Latest request for a live panel wins. */
  pushStoredArtifacts(
    ticketId: number,
    panel: DashboardPanel,
    settlesActions: boolean,
    host: SupplementalHost,
  ): void {
    if (!this.loadStoredArtifacts) return;
    const request = (this.storedRequests.get(ticketId) ?? 0) + 1;
    this.storedRequests.set(ticketId, request);
    const live = (): boolean => host.isCurrentPanel(ticketId, panel) && this.storedRequests.get(ticketId) === request;
    void this.loadStoredArtifacts(ticketId).then(
      (view) => {
        if (!live()) return;
        const previous = this.storedCache.get(ticketId);
        this.storedCache.set(ticketId, view);
        if (JSON.stringify(previous) !== JSON.stringify(view)) host.repush(ticketId, settlesActions);
      },
      (error) => {
        if (live()) this.logError('karst: dashboard stored artifacts failed', error);
      },
    );
  }

  /** The last loaded ship preview for a ticket, if any. */
  shipPreviewFor(ticketId: number): ShipPreview | undefined {
    return this.shipPreviewCache.get(ticketId);
  }

  /**
   * Read the advisory ship preview and re-push ONLY when it changed — a
   * follow-up to a `confirm`/`retry` snapshot, never polled. Only the latest
   * request for a live panel may land (a slower earlier read must not overwrite
   * a newer one), and the read is abandoned when the panel goes away.
   */
  pushShipPreview(
    ticketId: number,
    panel: DashboardPanel,
    settlesActions: boolean,
    host: SupplementalHost,
  ): void {
    if (!this.loadShipPreview) return;
    this.shipPreviewControllers.get(ticketId)?.abort();
    const controller = new AbortController();
    this.shipPreviewControllers.set(ticketId, controller);
    const request = (this.shipPreviewRequests.get(ticketId) ?? 0) + 1;
    this.shipPreviewRequests.set(ticketId, request);
    void this.loadShipPreview(ticketId, controller.signal).then(
      (preview) => {
        if (!host.isCurrentPanel(ticketId, panel)) return;
        if (this.shipPreviewRequests.get(ticketId) !== request) return;
        this.shipPreviewControllers.delete(ticketId);
        const previous = this.shipPreviewCache.get(ticketId);
        this.shipPreviewCache.set(ticketId, preview);
        if (JSON.stringify(previous) !== JSON.stringify(preview)) {
          host.repush(ticketId, settlesActions);
        }
      },
      (error) => {
        if (!host.isCurrentPanel(ticketId, panel)) return;
        if (this.shipPreviewRequests.get(ticketId) !== request) return;
        this.shipPreviewControllers.delete(ticketId);
        this.logError('karst: dashboard ship preview failed', error);
      },
    );
  }

  /**
   * Await one preview read and cache it, WITHOUT re-pushing — the explicit
   * Refresh path: the caller pushes the whole snapshot after, which is what
   * settles the Refresh pending (UI-R11/R12) even when nothing changed.
   */
  async reloadShipPreview(
    ticketId: number,
    panel: DashboardPanel,
    host: SupplementalHost,
  ): Promise<void> {
    if (!this.loadShipPreview) return;
    this.shipPreviewControllers.get(ticketId)?.abort();
    const controller = new AbortController();
    this.shipPreviewControllers.set(ticketId, controller);
    const request = (this.shipPreviewRequests.get(ticketId) ?? 0) + 1;
    this.shipPreviewRequests.set(ticketId, request);
    try {
      const preview = await this.loadShipPreview(ticketId, controller.signal);
      if (!host.isCurrentPanel(ticketId, panel)) return;
      if (this.shipPreviewRequests.get(ticketId) !== request) return;
      this.shipPreviewCache.set(ticketId, preview);
    } catch (error) {
      if (host.isCurrentPanel(ticketId, panel) && this.shipPreviewRequests.get(ticketId) === request) {
        this.logError('karst: dashboard ship preview refresh failed', error);
      }
    } finally {
      this.shipPreviewControllers.delete(ticketId);
    }
  }

  /** Cached base-branch candidates for a repoPath; `[]` until fetched. */
  branchCandidatesFor(repoPath: string): string[] {
    return this.branchCandidates.get(repoPath) ?? [];
  }

  /**
   * Load supplemental worktree filesystem facts without making the store-backed
   * state builder async. Only the latest request for the still-live panel may post.
   */
  pushWorktreeStats(
    ticketId: number,
    panel: DashboardPanel,
    worktrees: DashboardState['worktrees'],
    host: SupplementalHost,
  ): void {
    if (!this.loadStats) return;
    this.statsControllers.get(ticketId)?.abort();
    const controller = new AbortController();
    this.statsControllers.set(ticketId, controller);
    const request = (this.statsRequests.get(ticketId) ?? 0) + 1;
    this.statsRequests.set(ticketId, request);
    void this.loadStats(worktrees, controller.signal).then(
      (stats) => {
        if (!host.isCurrentPanel(ticketId, panel)) return;
        if (this.statsRequests.get(ticketId) !== request) return;
        this.statsControllers.delete(ticketId);
        panel.postMessage({ type: 'worktree-stats', stats });
      },
      (error) => {
        if (!host.isCurrentPanel(ticketId, panel)) return;
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
  pushGateOptions(
    ticketId: number,
    panel: DashboardPanel,
    settlesActions: boolean,
    host: SupplementalHost,
  ): void {
    if (!this.loadGateOptions) return;
    this.gateControllers.get(ticketId)?.abort();
    const controller = new AbortController();
    this.gateControllers.set(ticketId, controller);
    const request = (this.gateRequests.get(ticketId) ?? 0) + 1;
    this.gateRequests.set(ticketId, request);
    void this.loadGateOptions(ticketId, controller.signal).then(
      (options) => {
        if (!host.isCurrentPanel(ticketId, panel)) return;
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
          host.repush(ticketId, settlesActions);
        }
      },
      (error) => {
        if (!host.isCurrentPanel(ticketId, panel)) return;
        if (this.gateRequests.get(ticketId) !== request) return;
        this.gateControllers.delete(ticketId);
        this.logError('karst: dashboard gate options failed', error);
      },
    );
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
  prefetchBranchCandidates(
    ticketId: number,
    panel: DashboardPanel,
    worktrees: readonly WorktreeView[],
    host: SupplementalHost,
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
      if (!host.isCurrentPanel(ticketId, panel)) return;
      host.repush(ticketId, false);
    });
  }

  /** Abort and drop every per-ticket loader state. `branchCandidates` is shared and survives. */
  clear(ticketId: number): void {
    this.statsControllers.get(ticketId)?.abort();
    this.gateControllers.get(ticketId)?.abort();
    this.shipPreviewControllers.get(ticketId)?.abort();
    this.statsRequests.delete(ticketId);
    this.statsControllers.delete(ticketId);
    this.gateRequests.delete(ticketId);
    this.gateControllers.delete(ticketId);
    this.gateOptionsCache.delete(ticketId);
    this.baselineCache.delete(ticketId);
    this.baselineRequests.delete(ticketId);
    this.storedCache.delete(ticketId);
    this.storedRequests.delete(ticketId);
    this.shipPreviewCache.delete(ticketId);
    this.shipPreviewRequests.delete(ticketId);
    this.shipPreviewControllers.delete(ticketId);
  }
}
