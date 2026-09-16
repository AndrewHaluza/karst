import type { Store } from '../../store/db.js';
import type { Manifest } from '../../manifest/types.js';
import { DEFAULT_FIX_STALL_TIMEOUT_MINUTES } from '../../manifest/types.js';
import { sweepStalledFixRounds, describeStrandedFixRound } from '../../store/recoveryRounds.js';

export interface FixWatchdogDeps {
  store: Store;
  /** Minutes of no progress before a fix is parked. */
  timeoutMinutes: () => number;
  /**
   * The project whose configured window `timeoutMinutes` describes. The sweep
   * settles only this project's tickets, so one project's manifest window is
   * never applied to another project's fix. `null` (unbound) settles nothing.
   */
  projectId: () => number | null;
  now: () => string;
  log: (message: string) => void;
}

/**
 * The stall window for a ticket, in minutes: the larger of the two gate sections' configured
 * values, or `DEFAULT_FIX_STALL_TIMEOUT_MINUTES` when no manifest is loaded. The larger wins so
 * a project that runs long review fixes is never parked on the shorter uat window.
 */
export function stallTimeoutMinutes(manifest: Manifest | undefined): number {
  const uat = manifest?.uat?.stallTimeoutMinutes;
  const review = manifest?.review?.stallTimeoutMinutes;
  const configured = [uat, review].filter((n): n is number => typeof n === 'number' && n > 0);
  return configured.length === 0 ? DEFAULT_FIX_STALL_TIMEOUT_MINUTES : Math.max(...configured);
}

/** How often the watchdog ticks. */
export const FIX_WATCHDOG_INTERVAL_MS = 5 * 60_000;

/** One watchdog tick: park every fix that has shown no progress past the timeout. */
export function runFixWatchdog(deps: FixWatchdogDeps): number {
  const minutes = deps.timeoutMinutes();
  if (!Number.isFinite(minutes) || minutes <= 0) return 0;
  const settled = sweepStalledFixRounds(deps.store, {
    at: deps.now(),
    timeoutMs: minutes * 60_000,
    projectId: deps.projectId(),
  });
  for (const s of settled) deps.log(describeStrandedFixRound(s));
  return settled.length;
}

/**
 * Start the watchdog's timer. Returns a disposable the host pushes onto its subscriptions.
 *
 * The interval lives here rather than in `extension.ts` because that file is against its line
 * ratchet; the host's whole cost is one import and one positional `push(startFixWatchdog(...))`.
 *
 * The first tick runs IMMEDIATELY, which is what covers activation: unlike the boot sweep (which
 * runs before the manifest and project are resolvable), this is called once both getters exist, so
 * the project's own configured window is honored. A failed tick is reported through `onError`.
 */
export function startFixWatchdog(
  store: Store,
  manifest: () => Manifest | undefined,
  projectId: () => number | null,
  log: (message: string) => void,
  onError?: (message: string, err: unknown) => void,
): { dispose(): void } {
  const deps: FixWatchdogDeps = {
    store,
    timeoutMinutes: () => stallTimeoutMinutes(manifest()),
    projectId,
    now: () => new Date().toISOString(),
    log,
  };
  const tick = (): void => {
    try {
      runFixWatchdog(deps);
    } catch (err) {
      // A sweep must never take the timer down; the next tick retries — but the
      // failure is reported, never swallowed.
      onError?.('karst: fix stall watchdog tick failed', err);
    }
  };
  // Settle stalls at activation too, once. The boot sweep cannot do this: it
  // runs before the manifest and project are resolvable, so it could never
  // honor the project's configured window. This tick runs after the host's
  // getters exist, and on the interval thereafter.
  tick();
  const timer = setInterval(tick, FIX_WATCHDOG_INTERVAL_MS);
  return { dispose: () => clearInterval(timer) };
}
