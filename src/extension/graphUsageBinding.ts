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
import { claudeTrailingQuota, isInteractiveQuota } from '../agent/interactiveQuota.js';
import { makeOncePerError } from './ops/interactiveUsageLimitOps.js';
// Types come through the transport module: it is the sole AgentAdapter/AgentTransport bridge.
import type { SupervisedAgentSession, SupervisedLaunchRequest } from '../approaches/graph/transport/supervisedCliTransport.js';

/** The cores whose graph usage arrives as a hook (the opencode/opencode2 bridge plugins). */
const HOOK_USAGE_PROVIDERS: ReadonlySet<string> = new Set(['opencode2', 'opencode']);

/** T1380: a Claude graph transcript carried the provider's quota verdict. */
export interface GraphClaudeUsageLimitSignal {
  ticketId: number;
  graphRunId: number;
  runId: number;
  role: 'node' | 'planner';
  provider: 'claude';
  text: string;
}

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
  /** T1380: a graph claude transcript ended on a quota error; park the run. */
  onGraphUsageLimit?: (signal: GraphClaudeUsageLimitSignal) => void;
}

export interface GraphUsageBinding {
  /**
   * The hook channel of a graph launch. Only opencode and opencode2 get one
   * (T1380 adds opencode): claude usage comes from the transcript sweep, and a
   * claude hook channel would carry
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
  // Keyed by `(graph run, graph launch id)` — never the ticket's own session
  // key — so repeated sweeps of one error line report it once (T1380).
  const oncePerError = makeOncePerError();
  return {
    hookChannelFor: (request) => {
      if (request.identity?.provider === undefined || !HOOK_USAGE_PROVIDERS.has(request.identity.provider)) {
        return undefined;
      }
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
          onGraphTranscript: (session, launchId, text) => {
            const quota = claudeTrailingQuota(text);
            if (!quota || !isInteractiveQuota('claude', quota.text)) return;
            // The graph launch id isolates this read from the ticket session's
            // transcript watch: the same error reported on several ticks offers
            // once, and a later human entry reads as no quota at all.
            if (!oncePerError(session.graphRunId, launchId, quota.key)) return;
            deps.onGraphUsageLimit?.({
              ticketId: session.ticketId,
              graphRunId: session.graphRunId,
              runId: session.runId,
              role: session.role,
              provider: 'claude',
              text: quota.text,
            });
          },
          dispatch: deps.dispatch,
          projectsDirFor: deps.projectsDirFor,
        },
        deps.sessions().map(graphClaudeSessionOf),
        states,
      );
    },
  };
}
