import type { Store } from '../../store/db.js';
import {
  BACKGROUND_WAIT_SWEEP_INTERVAL_MS,
  expireBackgroundWaits,
  type NotifyTicket,
  type TurnTracker,
} from '../../hooks/dispatch.js';

/**
 * A claude background wait that reached its deadline leaves blue with no hook
 * event (T993). Runs the sweep on an interval; a failing sweep is logged and
 * never stops the timer. Returns a disposable that stops it.
 */
export function startBackgroundWaitSweep(
  store: Store,
  tracker: TurnTracker,
  notify: NotifyTicket,
  debug: (message: string) => void,
): { dispose(): void } {
  const timer = setInterval(() => {
    try {
      expireBackgroundWaits(store, tracker, notify);
    } catch (error) {
      debug(`[background-wait] sweep failed: ${String(error)}`);
    }
  }, BACKGROUND_WAIT_SWEEP_INTERVAL_MS);
  return { dispose: () => clearInterval(timer) };
}
