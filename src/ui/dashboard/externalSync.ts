/**
 * Fan an external database change (a `karst` CLI write, seen through
 * `PRAGMA data_version`) out to the open dashboards without running every
 * supplemental loader on every change.
 *
 * A visible panel gets the store-backed snapshot at once (`pushStoreState`), so
 * the new row appears without delay. The supplemental loaders (worktree Git
 * totals, gate options, baselines, stored artifacts) answer questions about the
 * worktree and the manifest, so they run once on a slower TRAILING timer: a
 * burst of CLI writes restarts the timer and costs one passive push. A hidden
 * panel does neither; it is marked stale and the manager runs the complete
 * push when the panel is shown. Host-agnostic: timers and the manager are
 * injected.
 */

/** Trailing wait before the supplemental loaders run after the last change. */
export const EXTERNAL_SUPPLEMENTAL_DELAY_MS = 3000;

export interface ExternalSyncDeps {
  openTicketIds(): number[];
  isVisible(ticketId: number): boolean;
  pushStoreState(ticketId: number): void;
  /** The complete redraw: store state plus the supplemental facts. */
  pushPassiveState(ticketId: number): void;
  markSupplementalStale(ticketId: number): void;
  logError(message: string, error: unknown): void;
  delayMs?: number;
  setTimer?: (cb: () => void, ms: number) => unknown;
  clearTimer?: (timer: unknown) => void;
}

export class ExternalChangeSync {
  private timer: unknown;
  private disposed = false;

  constructor(private readonly deps: ExternalSyncDeps) {}

  /** One external change: store state now for visible panels, supplemental later. */
  onChange(): void {
    if (this.disposed) return;
    for (const id of this.deps.openTicketIds()) {
      if (this.deps.isVisible(id)) this.guarded(() => this.deps.pushStoreState(id));
      else this.deps.markSupplementalStale(id);
    }
    this.restartTimer();
  }

  dispose(): void {
    this.disposed = true;
    this.cancelTimer();
  }

  private restartTimer(): void {
    this.cancelTimer();
    const set = this.deps.setTimer ?? ((cb, ms) => setTimeout(cb, ms));
    this.timer = set(() => {
      this.timer = undefined;
      this.runSupplemental();
    }, this.deps.delayMs ?? EXTERNAL_SUPPLEMENTAL_DELAY_MS);
  }

  private cancelTimer(): void {
    if (this.timer === undefined) return;
    (this.deps.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>)))(this.timer);
    this.timer = undefined;
  }

  private runSupplemental(): void {
    if (this.disposed) return;
    for (const id of this.deps.openTicketIds()) {
      if (this.deps.isVisible(id)) this.guarded(() => this.deps.pushPassiveState(id));
      else this.deps.markSupplementalStale(id);
    }
  }

  private guarded(run: () => void): void {
    try {
      run();
    } catch (error) {
      this.deps.logError('karst: external-change dashboard push failed', error);
    }
  }
}
