/**
 * The host seam for the token accounting of graph planner and node sessions
 * (T1370, `@arch:AC-14`). It keeps this wiring out of `extension.ts`.
 *
 * vscode-free: the host passes the endpoint, the live sessions and the seams.
 */

import type { HookChannel } from '../agent/adapter.js';
import type { HookPayload } from '../hooks/dispatch.js';
import type { ClaudeWatchState } from '../agent/claudeTranscriptWatch.js';
import { makeTranscriptReader } from '../agent/claudeTranscriptRead.js';
import { sweepGraphClaudeSessions, type GraphClaudeSession } from '../agent/graphClaudeSweep.js';
import { graphLaunchIdForLaunch } from '../approaches/graph/graphLaunchId.js';
// Types come through the transport module: it is the sole AgentAdapter/AgentTransport bridge.
import type { SupervisedAgentSession, SupervisedLaunchRequest } from '../approaches/graph/transport/supervisedCliTransport.js';

/** The only core whose graph usage arrives as a hook (the opencode2 bridge plugin). */
const HOOK_USAGE_PROVIDER = 'opencode2';

export interface GraphUsageBindingDeps {
  /** The bound hook endpoint URL; undefined while the endpoint is not bound. */
  endpointUrl(): string | undefined;
  readonly configDir: string;
  projectKey(): string | undefined;
  /** The live graph sessions; empty while the graph transport is not wired. */
  sessions(): readonly SupervisedAgentSession[];
  dispatch(payload: HookPayload): void;
  /** The claude `projects/` dir that holds the transcript of this session id. */
  projectsDirFor(sessionId: string): string;
  debug(message: string): void;
  onError(message: string, error: unknown): void;
}

export interface GraphUsageBinding {
  /**
   * The hook channel of a graph launch. Only opencode2 gets one: claude usage
   * comes from the transcript sweep, and a claude hook channel would carry
   * lifecycle events for a ticket that has no session of its own. The channel
   * carries a GRAPH launch id (`graph-<run>-<role>-<id>`), never a ticket
   * generation, so dispatch routes the event down its usage-only path. It does
   * not mark a ticket launch: that would make the ticket session read as stale.
   */
  hookChannelFor(request: SupervisedLaunchRequest): HookChannel | undefined;
  /** Sweep the transcript of each live claude graph session once. */
  sweep(): Promise<number>;
}

/** A transport session as the claude graph sweep reads it. Supervised CLI sessions run on the host. */
export function graphClaudeSessionOf(session: SupervisedAgentSession): GraphClaudeSession {
  return {
    ticketId: session.ticketId,
    graphRunId: session.graphRunId,
    runId: session.nodeRunId,
    role: session.runKind ?? 'node',
    cwd: session.cwd,
    provider: session.provider,
    providerSessionId: session.providerSessionId,
    generation: session.generation,
    placement: 'host',
  };
}

export function createGraphUsageBinding(deps: GraphUsageBindingDeps): GraphUsageBinding {
  // Keyed by graph launch id, never by ticket, so a graph session never
  // shares the ticket session's state.
  const states = new Map<string, ClaudeWatchState>();
  return {
    hookChannelFor: (request) => {
      if (request.identity?.provider !== HOOK_USAGE_PROVIDER) return undefined;
      const endpointUrl = deps.endpointUrl();
      if (endpointUrl === undefined) {
        deps.debug('[graph] hook endpoint is not bound — the launch records no usage');
        return undefined;
      }
      const launchId = graphLaunchIdForLaunch(request);
      const hookEndpoint = new URL(endpointUrl);
      hookEndpoint.searchParams.set('karstLaunch', launchId);
      return {
        endpointUrl: hookEndpoint.toString(),
        configDir: deps.configDir,
        launchId,
        projectKey: deps.projectKey(),
      };
    },
    sweep: () => {
      const reader = makeTranscriptReader();
      return sweepGraphClaudeSessions(
        {
          stat: reader.stat,
          readFile: reader.readFile,
          debug: deps.debug,
          onError: deps.onError,
          onTranscript: () => undefined,
          dispatch: deps.dispatch,
          projectsDirFor: deps.projectsDirFor,
        },
        deps.sessions().map(graphClaudeSessionOf),
        states,
      );
    },
  };
}
