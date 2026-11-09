import { LiveHeadlessUsage, sweepLiveHeadless, type LiveHeadlessSession, type LiveRunUsage } from '../agent/liveHeadlessUsage.js';
import { makeTranscriptReader } from '../agent/claudeTranscriptRead.js';

/** The call attribution the agent seam passes to its hooks. */
interface LiveCallTracking {
  readonly processRunId?: number | null;
  readonly ticketId?: number | null;
}

export interface LiveHeadlessBinding {
  /** Seam hook: tracks a headless Claude call that has a process run; returns its release. */
  onLiveSession(session: LiveHeadlessSession, tracking?: LiveCallTracking): (() => void) | undefined;
  /** Dashboard read of the live count of the given process runs. */
  read(runIds: readonly number[]): LiveRunUsage | null;
  /** One read of every tracked call, run on the existing transcript watch tick (no timer here). */
  tick(): Promise<void>;
}

export interface LiveHeadlessBindingDeps {
  debug(message: string): void;
  /** Called for each ticket whose live reading changed. */
  onChanged(ticketId: number): void;
}

/** Live token reading of running headless Claude calls (@arch:AC-14): memory only, never a ledger row. */
export function createLiveHeadlessBinding(deps: LiveHeadlessBindingDeps): LiveHeadlessBinding {
  const usage = new LiveHeadlessUsage();
  return {
    onLiveSession: (session, tracking) =>
      typeof tracking?.processRunId === 'number'
        ? usage.register(tracking.processRunId, tracking.ticketId ?? null, session)
        : undefined,
    read: (runIds) => usage.read(runIds),
    async tick() {
      const reader = makeTranscriptReader();
      const changed = await sweepLiveHeadless(usage, {
        stat: reader.stat,
        readFile: reader.readFile,
        debug: deps.debug,
      });
      for (const ticketId of changed) deps.onChanged(ticketId);
    },
  };
}
