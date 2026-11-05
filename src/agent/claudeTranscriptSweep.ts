import type { HookPayload } from '../hooks/dispatch.js';
import {
  claudeTranscriptTick,
  parseClaudeTranscript,
  type ClaudeTranscriptSnapshot,
  type ClaudeWatchState,
} from './claudeTranscriptWatch.js';

/** Injected seams: the sweep touches no fs, store or vscode itself. */
export interface ClaudeSweepDeps {
  stat(path: string): Promise<{ readonly mtimeMs: number; readonly size: number }>;
  readFile(path: string): Promise<string>;
  debug(message: string): void;
  onError(message: string, error: unknown): void;
  /** The usage-limit read of the same transcript text. */
  onTranscript(ticketId: number, sessionId: string, text: string): void;
  /** Posts one UsageUpdate through the shared hook seam. */
  dispatch(payload: HookPayload): void;
}

export interface ClaudeSweepInput {
  readonly ticketId: number;
  readonly sessionId: string;
  readonly transcriptPath: string;
  /** The payload cwd (the host worktree), never the sandbox path. */
  readonly cwd: string;
  readonly launchId?: string;
  readonly state: ClaudeWatchState;
}

export type ClaudeSweepOutcome = 'missing' | 'unchanged' | 'read-failed' | 'swept';

/** One transcript sweep for one ticket: host and sandbox tickets share this single path. */
export async function sweepClaudeTranscript(
  deps: ClaudeSweepDeps,
  input: ClaudeSweepInput,
): Promise<ClaudeSweepOutcome> {
  const { ticketId, sessionId, transcriptPath, state } = input;
  let fingerprint: { mtimeMs: number; size: number };
  try {
    const st = await deps.stat(transcriptPath);
    fingerprint = { mtimeMs: st.mtimeMs, size: st.size };
  } catch (error) {
    // No transcript yet is normal; the debug line makes a wrong path visible.
    deps.debug(`[claude] ticket ${ticketId}: transcript missing: ${transcriptPath} (${(error as NodeJS.ErrnoException).code ?? 'error'})`);
    return 'missing';
  }
  if (
    state.transcriptPath === transcriptPath &&
    state.fingerprint !== null &&
    state.fingerprint.mtimeMs === fingerprint.mtimeMs &&
    state.fingerprint.size === fingerprint.size
  ) {
    return 'unchanged';
  }
  let text: string;
  try {
    text = await deps.readFile(transcriptPath);
  } catch (error) {
    deps.onError(`karst: claude transcript read failed for ticket ${ticketId}`, error);
    return 'read-failed';
  }
  deps.onTranscript(ticketId, sessionId, text);
  const usage = parseClaudeTranscript(text);
  const snapshot: ClaudeTranscriptSnapshot = { transcriptPath, usage };
  const events = claudeTranscriptTick(state, snapshot);
  state.fingerprint = fingerprint;
  deps.debug(
    `[claude] ticket ${ticketId}: usage=${usage ? `${usage.input}/${usage.output}/${usage.cacheRead}/${usage.cacheWrite}` : 'null'}, events=${events.length}, launchId=${input.launchId ?? 'none'}`,
  );
  for (const event of events) {
    try {
      deps.dispatch({
        hook_event_name: 'UsageUpdate',
        cwd: input.cwd,
        session_id: sessionId,
        usage: event.usage,
        ...(input.launchId ? { launchId: input.launchId } : {}),
      });
    } catch (error) {
      deps.onError(`karst: claude transcript usage dispatch failed for ticket ${ticketId}`, error);
    }
  }
  return 'swept';
}
