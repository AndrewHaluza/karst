import type { LogError } from '../../logging/logger.js';
import { hasLiveWork, LIVE_TICK_MS } from './liveTick.js';
import type { DashboardState } from './state.js';
import type { DashboardPanel } from './panelTypes.js';

/** What the ticker needs from the manager that owns the panels. */
export interface LiveTickerHost {
  panelFor(ticketId: number): DashboardPanel | undefined;
  /** Push one live (clock-repaint) snapshot. */
  repaint(ticketId: number): void;
  logError: LogError;
}

/**
 * The pending live-snapshot timer per ticket (§ liveTick.ts). A self-
 * rescheduling `setTimeout` rather than an interval: a push that finds
 * nothing running simply does not schedule the next one, so a settled ticket
 * costs nothing and there is no timer to remember to stop. Dies with the
 * panel — a timer that outlives its panel is a store read for a window
 * nobody is looking at.
 */
export class LiveTicker {
  private readonly timers = new Map<number, ReturnType<typeof setTimeout>>();

  constructor(private readonly host: LiveTickerHost) {}

  /** Whether a tick is currently armed for the ticket. */
  has(ticketId: number): boolean {
    return this.timers.has(ticketId);
  }

  /** Cancel the armed tick (if any). */
  cancel(ticketId: number): void {
    const armed = this.timers.get(ticketId);
    if (armed) clearTimeout(armed);
    this.timers.delete(ticketId);
  }

  /**
   * Keep the snapshot moving while the ticket is moving.
   *
   * The host pushes state when a stage transitions and when a gate completes,
   * but the inside block is process-led: a tester run, a findings lane, a
   * pr-description call and a running gate all open their store rows and then
   * take minutes, during which nothing pushed and the panel showed the world as
   * it was when the stage last moved. The `inside-progress` overlay narrates
   * only the ONE operation the driver knows about; every other row, and every
   * running row's elapsed time, needs the authoritative snapshot to be re-read.
   *
   * Re-armed from the state it just pushed (`hasLiveWork`), so it stops itself
   * the moment nothing is running — a settled or parked ticket schedules no
   * timer at all. A panel disposed between two ticks drops the push in the same
   * `pushState` guard every other caller relies on.
   *
   * A panel that is not VISIBLE stops the loop entirely rather than repainting
   * a webview nobody can see; `onDidChangeViewState` restarts it with one
   * catch-up repaint the moment the panel comes back. Visibility, never
   * activation: the dashboard's whole purpose is to be watched beside a
   * terminal the user is typing in, which is visible and inactive.
   */
  schedule(ticketId: number, state: DashboardState): void {
    const pending = this.timers.get(ticketId);
    if (pending) {
      clearTimeout(pending);
      this.timers.delete(ticketId);
    }
    if (!hasLiveWork(state)) return;
    const panel = this.host.panelFor(ticketId);
    if (!panel) return;
    if (panel.isVisible?.() === false) return;
    const timer = setTimeout(() => {
      this.timers.delete(ticketId);
      if (!this.host.panelFor(ticketId)) return;
      try {
        this.host.repaint(ticketId);
      } catch (err) {
        // A tick is a repaint, never a mutation: a failed read (a deleted
        // ticket, a locked DB) must not take the extension host down, and it
        // must not re-arm — the next real push restarts the loop.
        this.host.logError('karst: dashboard live tick failed', err);
      }
    }, LIVE_TICK_MS);
    // Never hold the host's event loop open for a repaint.
    (timer as { unref?: () => void }).unref?.();
    this.timers.set(ticketId, timer);
  }
}
