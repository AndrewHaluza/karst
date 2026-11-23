/**
 * The host sleep ledger.
 *
 * On macOS a host sleep is invisible to both wall clocks: `Date.now()`,
 * `process.hrtime` and `performance.now` all count the slept time (T1318). A
 * pending Node timer therefore fires at wake, and a stall window that compares
 * timestamps reads a 2 hour sleep as 2 hours of work.
 *
 * This ledger records the gaps an awake process can prove: its own tick timer
 * fires every `tickMs`, so a gap of more than `gapMs` between two ticks is a
 * host sleep (or a blocked event loop, which only ever makes a stall show
 * LATER, never earlier). A read also counts the still-open gap, because at wake
 * a sweep timer can fire before the ledger's own tick timer.
 *
 * It is in memory for one window: a reload loses it, and code without a started
 * ledger (the CLI, tests) reads zero sleep.
 */

/** How often a started ledger ticks. */
export const SLEEP_TICK_MS = 15_000;
/** A gap between two ticks longer than this is a sleep. */
export const SLEEP_GAP_MS = 45_000;
/** The ledger keeps this many sleeps; a sleep older than that stops being subtracted. */
export const SLEEP_MAX_ENTRIES = 500;
/** One event is worth recording once this much sleep sits in one wake run. */
export const SLEEP_EVENT_MIN_SLEPT_MS = 5 * 60_000;
/** Awake time after a run of sleeps before it is reported (a run of DarkWakes is ONE event). */
export const SLEEP_EVENT_SETTLE_MS = 2 * 60_000;

export interface SleepInterval {
  startMs: number;
  endMs: number;
}

export interface SleepEvent extends SleepInterval {
  sleptMs: number;
}

export type SleepReporter = (event: SleepEvent) => void;

export interface SleepLedgerOptions {
  /** The clock, injected: a test drives it by hand. */
  now: () => number;
  /** How often a started ledger ticks; the interval `startSleepLedger` arms. */
  tickMs?: number;
  /** A gap between two ticks longer than this is a sleep. */
  gapMs?: number;
  /** The bound on the recorded sleeps; the oldest drop first. */
  maxEntries?: number;
  /** Where a reported wake run goes (one event per run). */
  report?: SleepReporter;
}

export interface SleepLedger {
  readonly tickMs: number;
  /** Record the gap since the last tick as a sleep, then mark this tick. */
  tick(): void;
  /** Wall time since `sinceMs`, minus the sleep inside it; never below 0. */
  awakeElapsedMs(sinceMs: number, nowMs: number): number;
  /** The wall length that holds `windowMs` of awake time before `nowMs`. */
  awakeWindowMs(windowMs: number, nowMs: number): number;
  /** Bind (or, with `undefined`, drop) the wake-run reporter. */
  setReporter(report: SleepReporter | undefined): void;
}

interface SleepRun extends SleepEvent {
  reported: boolean;
}

export function createSleepLedger(options: SleepLedgerOptions): SleepLedger {
  const { now } = options;
  const tickMs = options.tickMs ?? SLEEP_TICK_MS;
  const gapMs = options.gapMs ?? SLEEP_GAP_MS;
  const maxEntries = options.maxEntries ?? SLEEP_MAX_ENTRIES;
  const sleeps: SleepInterval[] = [];
  let lastTick = now();
  let report = options.report;
  let run: SleepRun | undefined;

  /** The open gap, when the ledger has not ticked since it started. */
  const openGapMs = (nowMs: number): number => {
    const gap = nowMs - lastTick;
    return gap > gapMs ? gap : 0;
  };

  /** How much of `[sinceMs, nowMs]` the host slept. */
  const sleptBetween = (sinceMs: number, nowMs: number): number => {
    const overlap = (sleep: SleepInterval): number =>
      Math.max(0, Math.min(sleep.endMs, nowMs) - Math.max(sleep.startMs, sinceMs));
    let slept = 0;
    for (const sleep of sleeps) slept += overlap(sleep);
    // The OPEN gap must count on a read too: at wake a sweep timer can fire
    // before this ledger's own tick timer, and it must not read the sleep as
    // work.
    if (openGapMs(nowMs) > 0) slept += overlap({ startMs: lastTick, endMs: nowMs });
    return slept;
  };

  const awakeElapsedMs = (sinceMs: number, nowMs: number): number => {
    const wall = nowMs - sinceMs;
    if (!Number.isFinite(wall)) return wall;
    if (wall <= 0) return 0;
    return Math.max(0, wall - sleptBetween(sinceMs, nowMs));
  };

  /** The total sleep the ledger knows, an upper bound for a window search. */
  const totalSleepMs = (nowMs: number): number => {
    let total = 0;
    for (const sleep of sleeps) total += Math.max(0, sleep.endMs - sleep.startMs);
    return total + openGapMs(nowMs);
  };

  const awakeWindowMs = (windowMs: number, nowMs: number): number => {
    if (!Number.isFinite(windowMs) || windowMs <= 0) return windowMs <= 0 ? 0 : windowMs;
    if (!Number.isFinite(nowMs)) return windowMs;
    // Awake time is monotonic in the wall length looked at, so the answer is
    // the smallest wall length that holds the whole window.
    let lo = 0;
    let hi = windowMs + totalSleepMs(nowMs);
    while (hi - lo > 1) {
      const mid = Math.floor((lo + hi) / 2);
      if (awakeElapsedMs(nowMs - mid, nowMs) >= windowMs) hi = mid;
      else lo = mid;
    }
    return hi;
  };

  const recordSleep = (startMs: number, endMs: number): void => {
    sleeps.push({ startMs, endMs });
    if (sleeps.length > maxEntries) sleeps.splice(0, sleeps.length - maxEntries);
    // A DarkWake run is ONE event: consecutive sleeps less than the settle
    // window apart belong to the same run.
    if (run !== undefined && startMs - run.endMs < SLEEP_EVENT_SETTLE_MS) {
      run.sleptMs += endMs - startMs;
      run.endMs = endMs;
      return;
    }
    run = { startMs, endMs, sleptMs: endMs - startMs, reported: false };
  };

  /**
   * Report a wake run once the host has been awake for the settle window: the
   * first moments after a wake are another DarkWake, not work. No toast —
   * `report` writes to the event log (@arch:NTF-05).
   */
  const maybeReport = (at: number): void => {
    if (run === undefined || run.reported) return;
    if (at - run.endMs < SLEEP_EVENT_SETTLE_MS) return;
    if (run.sleptMs < SLEEP_EVENT_MIN_SLEPT_MS) return;
    run.reported = true;
    report?.({ startMs: run.startMs, endMs: run.endMs, sleptMs: run.sleptMs });
  };

  return {
    tickMs,
    tick(): void {
      const at = now();
      if (at - lastTick > gapMs) recordSleep(lastTick, at);
      // A backward clock step records nothing and never moves the marked tick
      // backwards: the timeline stays monotonic, so no false sleep appears when
      // the clock catches up.
      lastTick = Math.max(lastTick, at);
      maybeReport(at);
    },
    awakeElapsedMs,
    awakeWindowMs,
    setReporter(next: SleepReporter | undefined): void {
      report = next;
    },
  };
}

/** The one process-wide ledger every stall window reads; a no-op until started. */
export const defaultSleepLedger = createSleepLedger({ now: () => Date.now() });

export interface SleepLedgerHandle {
  dispose(): void;
}

/**
 * The `Notify` shape the ledger reports through (`extension/ops/notify.ts`):
 * the record-only path, so a wake run lands in the event log and shows no
 * toast (@arch:NTF-05). Structural, so `runtime` takes no dependency on the
 * ops layer.
 */
export interface SleepNotify {
  record?: (level: 'info', message: string) => void;
}

/** The message one wake run records: its start, its end and its slept minutes. */
export function sleepEventMessage(event: SleepEvent): string {
  const minutes = Math.max(1, Math.round(event.sleptMs / 60_000));
  const start = new Date(event.startMs).toISOString();
  const end = new Date(event.endMs).toISOString();
  return `karst: the host slept ${minutes} min (${start} → ${end}); command timeouts and stall windows counted awake time only`;
}

/**
 * Start the process-wide ledger: tick it on an unref'd interval and record one
 * event per wake run. Bound once in `src/extension.ts` activation; without it
 * the ledger reads zero sleep.
 */
export function startSleepLedger(
  notify?: SleepNotify,
  tickMs = defaultSleepLedger.tickMs,
): SleepLedgerHandle {
  defaultSleepLedger.setReporter(
    notify === undefined ? undefined : (event) => notify.record?.('info', sleepEventMessage(event)),
  );
  const timer = setInterval(() => defaultSleepLedger.tick(), tickMs);
  timer.unref?.();
  let disposed = false;
  return {
    dispose(): void {
      if (disposed) return;
      disposed = true;
      clearInterval(timer);
      defaultSleepLedger.setReporter(undefined);
    },
  };
}
