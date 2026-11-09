import { parseClaudeTranscript, type ClaudeTranscriptUsage } from './claudeTranscriptWatch.js';

/**
 * Live token reading of a running headless Claude call (@arch:AC-14).
 *
 * `claude -p --output-format json` reports its count only when the call ends.
 * While it runs, the CLI already appends usage to the session transcript, so a
 * host tick reads that file. The reading lives in MEMORY, keyed by process run
 * id. It is never written to `token_usage`: the single row `instrumentAdapter`
 * records at the end stays the only ledger record of the call, and it replaces
 * the reading (`register` returns the release the seam calls after that write).
 */

/** What a core reports when it starts a live-readable headless call. */
export interface LiveHeadlessSession {
  sessionId: string;
  /** Absolute path of the transcript the core writes while the call runs. */
  transcriptPath: string;
}

/** The counts read from a transcript. `cacheRead` stays apart from the fresh counts. */
export type LiveUsageReading = Pick<ClaudeTranscriptUsage, 'input' | 'output' | 'cacheRead' | 'cacheWrite'>;

/** The reading of the runs a row shows. `total` is provider-faithful: cache reads included. */
export interface LiveRunUsage {
  total: number;
  cacheRead: number;
}

/** Reads the live count of the given process-run ids; null when none has a reading. */
export type LiveRunUsageReader = (runIds: readonly number[]) => LiveRunUsage | null;

interface Entry {
  readonly ticketId: number | null;
  readonly session: LiveHeadlessSession;
  reading: LiveUsageReading | null;
  /** Fingerprint of the last transcript read, so an unchanged file is not read again. */
  fingerprint: { mtimeMs: number; size: number } | null;
  /** The last fault written to the debug log, so a steady fault logs once, not on every tick. */
  fault: string | null;
}

/** A call that is being read now: the sweep's work item. */
export interface LiveHeadlessTarget {
  readonly runId: number;
  readonly ticketId: number | null;
  readonly session: LiveHeadlessSession;
}

/** In-memory live readings. One run can hold several calls at once (one per target). */
export class LiveHeadlessUsage {
  private readonly runs = new Map<number, Map<string, Entry>>();

  /** Starts to track a call. The returned release is idempotent and drops the reading. */
  register(runId: number, ticketId: number | null, session: LiveHeadlessSession): () => void {
    const calls = this.runs.get(runId) ?? new Map<string, Entry>();
    this.runs.set(runId, calls);
    const entry: Entry = { ticketId, session, reading: null, fingerprint: null, fault: null };
    calls.set(session.sessionId, entry);
    return () => {
      const current = this.runs.get(runId);
      if (current?.get(session.sessionId) !== entry) return;
      current.delete(session.sessionId);
      if (current.size === 0) this.runs.delete(runId);
    };
  }

  targets(): LiveHeadlessTarget[] {
    const out: LiveHeadlessTarget[] = [];
    for (const [runId, calls] of this.runs) {
      for (const entry of calls.values()) out.push({ runId, ticketId: entry.ticketId, session: entry.session });
    }
    return out;
  }

  /** The reading of the given runs, summed over their calls; null when no call has one. */
  read(runIds: readonly number[]): LiveRunUsage | null {
    let found = false;
    let total = 0;
    let cacheRead = 0;
    for (const runId of runIds) {
      for (const { reading } of this.runs.get(runId)?.values() ?? []) {
        if (reading === null) continue;
        found = true;
        total += reading.input + reading.output + reading.cacheRead + reading.cacheWrite;
        cacheRead += reading.cacheRead;
      }
    }
    return found ? { total, cacheRead } : null;
  }

  /** Stores a reading (null clears it). True when the stored reading changed. */
  update(
    runId: number,
    sessionId: string,
    reading: LiveUsageReading | null,
    fingerprint: { mtimeMs: number; size: number } | null,
  ): boolean {
    const entry = this.runs.get(runId)?.get(sessionId);
    if (!entry) return false;
    const before = entry.reading;
    entry.reading = reading;
    entry.fingerprint = fingerprint;
    return (
      before?.input !== reading?.input ||
      before?.output !== reading?.output ||
      before?.cacheRead !== reading?.cacheRead ||
      before?.cacheWrite !== reading?.cacheWrite
    );
  }

  /** True when `fault` differs from the last one noted for the call (null clears it). */
  noteFault(runId: number, sessionId: string, fault: string | null): boolean {
    const entry = this.runs.get(runId)?.get(sessionId);
    if (!entry || entry.fault === fault) return false;
    entry.fault = fault;
    return fault !== null;
  }

  fingerprintOf(runId: number, sessionId: string): Entry['fingerprint'] {
    return this.runs.get(runId)?.get(sessionId)?.fingerprint ?? null;
  }
}

/** Injected seams: the sweep touches no fs and no vscode itself. */
export interface LiveHeadlessSweepDeps {
  stat(path: string): Promise<{ readonly mtimeMs: number; readonly size: number }>;
  readFile(path: string): Promise<string>;
  debug(message: string): void;
}

/**
 * One read of every tracked call, on the host's existing transcript watch tick.
 * A missing or unreadable transcript clears the call's reading (the row falls
 * back to the placeholder), writes a debug line and never throws: a read fault
 * must never fail the run. Returns the ticket ids whose reading changed.
 */
export async function sweepLiveHeadless(
  usage: LiveHeadlessUsage,
  deps: LiveHeadlessSweepDeps,
): Promise<number[]> {
  const changed = new Set<number>();
  for (const { runId, ticketId, session } of usage.targets()) {
    const { sessionId, transcriptPath } = session;
    let fingerprint: { mtimeMs: number; size: number };
    try {
      const st = await deps.stat(transcriptPath);
      fingerprint = { mtimeMs: st.mtimeMs, size: st.size };
    } catch (error) {
      // No transcript yet is normal at the start of a call.
      const code = (error as NodeJS.ErrnoException).code ?? 'error';
      const fault = `not readable (${code})`;
      if (usage.noteFault(runId, sessionId, fault)) deps.debug(`[claude] live usage run ${runId}: transcript ${fault}: ${transcriptPath}`);
      if (usage.update(runId, sessionId, null, null) && ticketId !== null) changed.add(ticketId);
      continue;
    }
    const last = usage.fingerprintOf(runId, sessionId);
    if (last !== null && last.mtimeMs === fingerprint.mtimeMs && last.size === fingerprint.size) continue;
    try {
      const text = await deps.readFile(transcriptPath);
      const parsed = parseClaudeTranscript(text, { dedupeMessages: true });
      const reading = parsed
        ? { input: parsed.input, output: parsed.output, cacheRead: parsed.cacheRead, cacheWrite: parsed.cacheWrite }
        : null;
      usage.noteFault(runId, sessionId, null);
      if (usage.update(runId, sessionId, reading, fingerprint) && ticketId !== null) changed.add(ticketId);
    } catch (error) {
      const fault = `read failed (${String(error)})`;
      if (usage.noteFault(runId, sessionId, fault)) deps.debug(`[claude] live usage run ${runId}: transcript ${fault}: ${transcriptPath}`);
      if (usage.update(runId, sessionId, null, null) && ticketId !== null) changed.add(ticketId);
    }
  }
  return [...changed];
}
