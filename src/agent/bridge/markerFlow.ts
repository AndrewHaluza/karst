import type { MarkerStage } from '../markerStage.js';
import type { MarkerReply } from './markerReply.js';

/** The host's verdict on one marker run. `transient` = worth retrying; `diverged` = the host branch diverged (asks the user). */
export interface MarkerOutcome {
  readonly code: number;
  readonly stderr: string;
  readonly transient?: boolean;
  readonly diverged?: boolean;
}

export interface MarkerFailure {
  readonly stage: MarkerStage;
  readonly reason: string;
  readonly diverged: boolean;
  /** Retries are spent and the pending marker dropped; the user's "Retry now" requeues it with a fresh counter. */
  readonly gaveUp?: boolean;
}

/** A transient failure waiting on its backoff timer. */
export interface QueuedMarker {
  readonly stage: MarkerStage;
  readonly reason: string;
  /** Retries scheduled so far (1 after the first failure). */
  readonly attempt: number;
  readonly maxRetries: number;
  /** Epoch ms of the next scheduled retry. */
  readonly nextAt: number;
}

export interface PendingMarkerStore {
  load(): Promise<MarkerStage | undefined>;
  save(stage: MarkerStage): Promise<void>;
  clear(): Promise<void>;
}

export interface MarkerFlowDeps {
  readonly runMarker: (stage: MarkerStage) => Promise<MarkerOutcome>;
  /** Write the agent's reply file; best effort (the agent's wait just times out). */
  readonly reply: (seq: string, reply: MarkerReply) => Promise<void>;
  readonly pending: PendingMarkerStore;
  /** The ticket's current stage, read live. */
  readonly currentStage: () => string | null;
  /** Warn-level log + user notification; `diverged` becomes a Needs-you blocker. */
  readonly report: (failure: MarkerFailure) => void;
  /** Returns a cancel function. */
  readonly schedule?: (fn: () => void, ms: number) => () => void;
  readonly backoffMs?: readonly number[];
  /** Retries after the first failure before the marker is dropped (default `MARKER_MAX_RETRIES`). */
  readonly maxRetries?: number;
  /** Clock seam for `status().nextAt`. */
  readonly now?: () => number;
}

export interface MarkerFlow {
  /** A verified marker line; `seq` is the agent's reply token. Serialised per ticket. */
  handle(stage: MarkerStage, seq: string | undefined): Promise<void>;
  /** Re-run a persisted transient marker (boot sweep, backoff timer, successful sync). */
  retryPending(): Promise<void>;
  /** The queued marker's reason, attempt and next retry time; `undefined` when nothing is waiting. */
  status(): QueuedMarker | undefined;
  /** Run the queued marker now, or requeue a gave-up one with a fresh retry counter. */
  retryNow(): Promise<void>;
  /** Resolves when queued work is done. */
  idle(): Promise<void>;
  stop(): void;
}

/** Retry steps after a transient failure; the last one repeats. */
/** A transient failure that never clears is abandoned after this many retries and shown to the user once. */
export const MARKER_MAX_RETRIES = 8;

export const MARKER_BACKOFF_MS: readonly number[] = [5_000, 15_000, 60_000, 300_000];

/**
 * One ticket's marker lifecycle (arch:AC-34): run, reply to the agent, keep a
 * transient failure for retry, surface every failure. Pure of IO beyond deps.
 */
export function createMarkerFlow(deps: MarkerFlowDeps): MarkerFlow {
  const schedule = deps.schedule ?? ((fn, ms) => { const h = setTimeout(fn, ms); h.unref?.(); return () => clearTimeout(h); });
  const backoff = deps.backoffMs ?? MARKER_BACKOFF_MS;
  let chain: Promise<void> = Promise.resolve();
  let cancelTimer: (() => void) | undefined;
  let attempt = 0;
  const maxRetries = deps.maxRetries ?? MARKER_MAX_RETRIES;
  let stopped = false;
  const now = deps.now ?? Date.now;
  let queued: QueuedMarker | undefined;
  let gaveUpStage: MarkerStage | undefined;

  const reply = async (seq: string | undefined, stage: MarkerStage, ok: boolean, retrying: boolean, reason: string): Promise<void> => {
    if (seq === undefined) return;
    try {
      await deps.reply(seq, { v: 1, stage, ok, retrying, reason });
    } catch {
      // Best effort: the agent's bounded wait reports "queued" on its own.
    }
  };
  const arm = (): void => {
    cancelTimer?.();
    if (stopped) return;
    const ms = backoff[Math.min(attempt, backoff.length - 1)]!;
    attempt += 1;
    if (queued) queued = { ...queued, attempt, nextAt: now() + ms };
    cancelTimer = schedule(() => { void retryPending(); }, ms);
  };
  const run = async (stage: MarkerStage, seq: string | undefined, retry: boolean): Promise<void> => {
    if (deps.currentStage() !== stage) {
      await deps.pending.clear();
      await reply(seq, stage, true, false, `stage ${stage} already advanced`);
      return;
    }
    let outcome: MarkerOutcome;
    try {
      outcome = await deps.runMarker(stage);
    } catch (err) {
      outcome = { code: 1, stderr: err instanceof Error ? err.message : String(err), transient: true };
    }
    if (outcome.code === 0) {
      cancelTimer?.();
      attempt = 0;
      queued = undefined;
      gaveUpStage = undefined;
      await deps.pending.clear();
      await reply(seq, stage, true, false, '');
      return;
    }
    const reason = outcome.stderr.trim() || `exited ${outcome.code}`;
    const diverged = outcome.diverged === true;
    const transient = outcome.transient === true && !diverged;
    if (transient && retry && attempt > maxRetries) {
      // Out of retries: say so once, stop persisting.
      deps.report({ stage, reason: `${reason} (gave up after ${maxRetries} retries)`, diverged, gaveUp: true });
      attempt = 0;
      queued = undefined;
      gaveUpStage = stage;
      await deps.pending.clear();
      return;
    }
    // A retry that fails again was already shown; only the first failure notifies.
    if (!retry) deps.report({ stage, reason, diverged });
    if (transient) {
      queued = { stage, reason, attempt, maxRetries, nextAt: 0 };
      await deps.pending.save(stage);
      arm();
    } else {
      queued = undefined;
      if (retry) deps.report({ stage, reason, diverged });
      await deps.pending.clear();
    }
    await reply(seq, stage, false, transient, reason);
  };
  const enqueue = (stage: MarkerStage, seq: string | undefined, retry: boolean): Promise<void> => {
    const next = chain.then(() => run(stage, seq, retry));
    chain = next.catch(() => undefined);
    return next;
  };
  async function retryPending(): Promise<void> {
    const stage = await deps.pending.load();
    if (stage === undefined) return;
    await enqueue(stage, undefined, true);
  }
  async function retryNow(): Promise<void> {
    const stage = (await deps.pending.load()) ?? gaveUpStage;
    if (stage === undefined) return;
    cancelTimer?.();
    attempt = 0;
    gaveUpStage = undefined;
    await enqueue(stage, undefined, false);
  }
  return {
    status: () => queued,
    retryNow,
    handle: (stage, seq) => enqueue(stage, seq, false),
    retryPending,
    idle: () => chain,
    stop: () => { stopped = true; cancelTimer?.(); },
  };
}
