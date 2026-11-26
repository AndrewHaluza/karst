import { graphLaunchId, type GraphLaunchRole } from '../approaches/graph/graphLaunchId.js';
import { transcriptPathFor, type ClaudeWatchState } from './claudeTranscriptWatch.js';
import { sweepClaudeTranscript, type ClaudeSweepDeps } from './claudeTranscriptSweep.js';

/**
 * The claude transcript sweep of graph planner and node sessions (T1370).
 *
 * A graph ticket has no session of its own, so the ticket sweep (which keys on
 * `tickets.session_id`) never reads a graph session's transcript. A graph
 * claude launch is pinned at spawn to a karst-chosen `--session-id`, so its
 * transcript path is known while it runs: `<projects>/<encoded cwd>/<id>.jsonl`,
 * where cwd is the session cwd (the ticket worktree for a planner, the node
 * workspace for a node). The sample goes through the same `UsageUpdate` seam,
 * tagged with the graph launch id, so dispatch takes the graph branch and the
 * store binds it to the running graph process run.
 *
 * vscode-free: the host passes the live sessions and the seams.
 */

/** One live graph session, as the host transport reports it. */
export interface GraphClaudeSession {
  readonly ticketId: number;
  readonly graphRunId: number;
  /** The planner-run id or the node-run id; `role` names the table. */
  readonly runId: number;
  readonly role: GraphLaunchRole;
  readonly cwd: string;
  /** Null/undefined = unknown (a re-attached session): never swept. */
  readonly provider: string | null | undefined;
  readonly providerSessionId: string | null;
  /** The run's launch generation (a UUID): the secret part of the launch id
   *  that dispatch checks against the run row. */
  readonly generation: string;
  /** Where the session runs. The transcript of a sandboxed session is not on
   *  the host projects dir, so it is skipped. */
  readonly placement: 'host' | 'sandbox';
}

export interface GraphClaudeSweepDeps extends ClaudeSweepDeps {
  /** The claude `projects/` dir that holds this session's transcript (the
   *  account of the session can move it with `CLAUDE_CONFIG_DIR`). */
  projectsDirFor(sessionId: string): string;
}

/** The session's graph launch id, or null when its generation is not a UUID. */
function launchIdOf(session: GraphClaudeSession): string | null {
  try {
    return graphLaunchId({
      graphRunId: session.graphRunId,
      runId: session.runId,
      role: session.role,
      generation: session.generation,
    });
  } catch (error) {
    if (error instanceof RangeError) return null;
    throw error;
  }
}

/**
 * Sweep each live claude graph session once. `states` is keyed by the graph
 * launch id, never by ticket, so it never collides with the ticket's own claude
 * state. An entry whose session is no longer live is removed (the session
 * ended). Returns how many sessions were swept (transcript read).
 */
export async function sweepGraphClaudeSessions(
  deps: GraphClaudeSweepDeps,
  sessions: readonly GraphClaudeSession[],
  states: Map<string, ClaudeWatchState>,
): Promise<number> {
  const live = new Set<string>();
  let swept = 0;
  for (const session of sessions) {
    if (session.provider !== 'claude') continue;
    const launchId = launchIdOf(session);
    if (launchId === null) {
      deps.debug(
        `[claude] graph ${session.role} run ${session.runId}: launch generation is not a UUID, not swept`,
      );
      continue;
    }
    live.add(launchId);
    // The generation suffix is the launch id's secret part: log without it.
    const label = `graph-${session.graphRunId}-${session.role}-${session.runId}`;
    const sessionId = session.providerSessionId;
    if (!sessionId) {
      deps.debug(`[claude] ${label}: no provider session id, transcript not locatable`);
      continue;
    }
    if (session.placement !== 'host') {
      deps.debug(`[claude] ${label}: ${session.placement} placement, transcript not on the host`);
      continue;
    }
    const state = states.get(launchId) ?? { transcriptPath: null, eventId: null, fingerprint: null };
    states.set(launchId, state);
    const outcome = await sweepClaudeTranscript(deps, {
      ticketId: session.ticketId,
      sessionId,
      transcriptPath: transcriptPathFor(deps.projectsDirFor(sessionId), session.cwd, sessionId),
      cwd: session.cwd,
      launchId,
      state,
    });
    if (outcome === 'swept') swept += 1;
  }
  for (const key of [...states.keys()]) {
    if (!live.has(key)) states.delete(key);
  }
  return swept;
}
