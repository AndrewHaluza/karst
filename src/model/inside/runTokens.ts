import type { ProcessRun } from '../../store/processRuns.js';
import type { SessionTokensInput } from './agent.js';

/** The ledger's spend for a set of process runs. Estimated rows stay apart from measured ones. */
export interface RunUsage {
  /** Measured total tokens (provider-faithful, cache reads included). */
  total: number;
  /** Measured cache reads. */
  cacheRead: number;
  /** Count of calls whose numbers are estimates. */
  estimatedCalls: number;
  /** Sum of the estimated calls' tokens. */
  estimatedTotal: number;
}

/** Reads the ledger for the given process-run ids. Injected: this module never touches the store. */
export type RunUsageReader = (runIds: readonly number[]) => RunUsage;

/** The live reading of running runs; null when there is none (@arch:AC-14). */
export type LiveRunUsageReader = (runIds: readonly number[]) => { total: number; cacheRead: number } | null;

/**
 * The token claim of the runs a row shows (@arch:AC-14).
 *
 * - No run: nothing to claim (null).
 * - Spend recorded: the measured count and the estimated rows, side by side.
 * - A running Claude headless call: its live reading, in the live style.
 * - Nothing recorded and a run is still going: `pending`. The headless call
 *   reports its count only when it ends, so a running row has no ledger row
 *   yet. It states that, and never reads as a measured "0 tok".
 * - Nothing recorded and every run ended: absent, as before.
 */
export function runsTokens(
  runs: readonly ProcessRun[],
  read: RunUsageReader,
  live?: LiveRunUsageReader,
): SessionTokensInput | null {
  if (runs.length === 0) return null;
  const ids = runs.map((r) => r.id);
  const running = runs.some((r) => r.status === 'running');
  const usage = read(ids);
  // A running call has no ledger row yet; its in-memory reading stands in. The
  // reading only ever ADDS to rows already recorded (another target of the same
  // round that ended), and the ledger row replaces it when the call ends.
  const liveUsage = running ? live?.(ids) ?? null : null;
  return usageTokens(
    liveUsage
      ? { ...usage, total: usage.total + liveUsage.total, cacheRead: usage.cacheRead + liveUsage.cacheRead }
      : usage,
    running,
  );
}

/** The same rules for a spend that is not keyed by process run (the graph run's planner and node runs). */
export function usageTokens(usage: RunUsage, running: boolean): SessionTokensInput | null {
  const fresh = usage.total - usage.cacheRead;
  if (fresh > 0 || usage.estimatedCalls > 0) {
    return {
      total: usage.total,
      cacheRead: usage.cacheRead,
      estimatedCalls: usage.estimatedCalls,
      estimatedTotal: usage.estimatedTotal,
    };
  }
  return running ? { total: 0, pending: true } : null;
}
