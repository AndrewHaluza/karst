/**
 * A deadline that counts awake time only.
 *
 * On macOS a pending `setTimeout` counts the time the host sleeps: a 60 s
 * timeout armed before a 15 minute DarkWake fires the instant the host wakes,
 * before the child had a chance to make progress (T1318: `git clone` reported
 * "timed out after 60000ms" at wake, spending automatic recovery 2 of 3).
 * `process.hrtime` and `performance.now` are both the continuous clock, so a
 * wall-clock measurement cannot detect the sleep either.
 *
 * The chain credits only the nominal length of each chunk that actually fired.
 * A host sleep adds at most one chunk of overshoot (the chunk that was armed
 * when the machine slept), never the slept hour. No clock is read at all.
 */

export const AWAKE_CHUNK_MS = 1000;

export interface AwakeTimerDeps {
  set: (fn: () => void, ms: number) => unknown;
  clear: (handle: unknown) => void;
}

export interface AwakeDeadline {
  /** Stop the chain; idempotent, and `onExpire` can then never run. */
  cancel(): void;
}

/**
 * Run `onExpire` once after `ms` of awake time, in `setTimeout` chunks of at
 * most `AWAKE_CHUNK_MS`. `ms <= 0` expires on the next timer turn, like
 * `setTimeout(fn, 0)`.
 */
export function startAwakeDeadline(
  ms: number,
  onExpire: () => void,
  timers: AwakeTimerDeps = {
    // Resolved per call, not at module load, so a caller's fake timers (or a
    // spy on the global) still apply.
    set: (fn, chunkMs) => setTimeout(fn, chunkMs),
    clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  },
): AwakeDeadline {
  let remaining = Math.max(0, ms);
  let handle: unknown;
  let cancelled = false;

  const arm = (): void => {
    // The chunk that is armed across a sleep has already done its awake work
    // when the host wakes; crediting only its nominal length bounds a sleep to
    // one chunk of overshoot. `ms <= 0` arms a 0 ms chunk, so the expiry still
    // takes one timer turn — matching the `setTimeout(fn, 0)` it replaces.
    const chunk = Math.max(0, Math.min(remaining, AWAKE_CHUNK_MS));
    remaining -= chunk;
    handle = timers.set(fire, chunk);
  };

  const fire = (): void => {
    if (cancelled) return;
    if (remaining <= 0) {
      cancelled = true;
      onExpire();
      return;
    }
    arm();
  };

  arm();

  return {
    cancel(): void {
      if (cancelled) return;
      cancelled = true;
      if (handle !== undefined) timers.clear(handle);
    },
  };
}
