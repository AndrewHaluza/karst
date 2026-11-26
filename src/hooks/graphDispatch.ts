import type { Store } from '../store/db.js';
import type { HookDispatchOutcome } from '../diagnostics/hookChannel.js';
import { parseGraphLaunchId } from '../approaches/graph/graphLaunchId.js';
import {
  graphLaunchOwner,
  graphWorkspaceForCwd,
  type GraphLaunchOwner,
} from '../store/graph/sessionOwners.js';
import { canonicalPath } from '../runtime/pathScope.js';
import { isKnownProvider } from '../agent/provider.js';
import { recordUsageSample } from './usageIngest.js';

/** The fields of a hook payload the graph branch reads. */
export interface GraphHookPayload {
  hook_event_name?: string;
  cwd?: string;
  session_id?: string;
  usage?: unknown;
  launchId?: string;
}

export interface GraphHookDeps {
  notify?: (ticketId: number) => void;
  observe: (outcome: HookDispatchOutcome) => void;
  debug?: (msg: string) => void;
}

/** What the graph branch decided. `null` from `dispatchGraphHook` = not a graph session. */
export interface GraphHookResult {
  admitted: boolean;
  ticketId?: number;
}

/**
 * Who a graph session is, or null when the payload is not a graph session.
 * `kind: 'unowned'` is a graph session (its launch id has the graph shape) that
 * names no open run: it is still never handed to the ticket path.
 */
type GraphSession = { kind: 'owned'; owner: GraphLaunchOwner } | { kind: 'unowned'; why: string };

/**
 * How the caller identifies the graph session: `launch` reads only the launch
 * id (cheap, and the only marker of a planner, whose cwd IS the ticket
 * worktree); `workspace` reads only the cwd against the node workspace ledger
 * (the caller runs it after the worktree lookup found no ticket).
 */
export type GraphHookMatch = 'launch' | 'workspace';

function graphSessionOf(store: Store, payload: GraphHookPayload, match: GraphHookMatch): GraphSession | null {
  if (match === 'launch') {
    const launch = parseGraphLaunchId(payload.launchId);
    if (launch === null) return null;
    // The generation suffix is the launch id's secret part: it must equal the
    // run's persisted generation, or the id proves nothing.
    const owner = graphLaunchOwner(store.db, launch);
    return owner === null
      ? { kind: 'unowned', why: `launch graph-${launch.graphRunId}-${launch.role}-${launch.runId} names no open run of that generation` }
      : { kind: 'owned', owner };
  }
  if (!payload.cwd) return null;
  const workspace = graphWorkspaceForCwd(store.db, payload.cwd, canonicalPath);
  if (workspace === null) return null;
  const owner = graphLaunchOwner(store.db, {
    graphRunId: workspace.graphRunId,
    runId: workspace.nodeRunId,
    role: 'node',
  });
  return owner === null
    ? { kind: 'unowned', why: `workspace ${workspace.cwd} names no open node run` }
    : { kind: 'owned', owner };
}

function ingestGraphUsage(
  store: Store,
  payload: GraphHookPayload,
  owner: GraphLaunchOwner,
  deps: GraphHookDeps,
): boolean {
  const label = `[usage] graph ${owner.graphRunId} ${owner.role} ${owner.runId} (ticket ${owner.ticketId})`;
  if (!payload.session_id) {
    deps.debug?.(`${label}: skipped: no session_id`);
    return false;
  }
  // The provider of the GRAPH session, from its running process run — never the
  // ticket's provider: a claude planner can run on an opencode2 ticket.
  if (!isKnownProvider(owner.provider)) {
    deps.debug?.(`${label}: skipped: no running process run with a known provider (${owner.provider})`);
    return false;
  }
  return recordUsageSample(
    store,
    {
      ticketId: owner.ticketId,
      provider: owner.provider,
      providerSessionId: payload.session_id,
      usage: payload.usage,
    },
    deps.debug,
  );
}

/**
 * The graph branch of the hook dispatch (T1370). A payload is a graph session
 * when its launch id has the graph shape (`match: 'launch'`), or its cwd is a
 * node workspace of an open graph run (`match: 'workspace'`). Such a session admits ONLY `UsageUpdate`: the sample is
 * appended under the graph session's ticket and provider, and the store binds
 * it to the running graph process run. Every other event returns
 * `admitted: false` with no write at all — no agent_state, no session id, no
 * launch intent, no turn tracker, no liveness stamp, no notify — because a
 * graph session's lifecycle is not the ticket's.
 *
 * Returns null for a payload that is not a graph session; the caller then runs
 * the ticket path. Both matches run BEFORE the generation check: a graph launch
 * id is not the ticket's launch generation, so the generation check would
 * refuse every graph event. The `launch` match also runs before the worktree
 * lookup, because a planner's cwd is the ticket worktree.
 */
export function dispatchGraphHook(
  store: Store,
  payload: GraphHookPayload,
  deps: GraphHookDeps,
  match: GraphHookMatch,
): GraphHookResult | null {
  const session = graphSessionOf(store, payload, match);
  if (session === null) return null;
  const event = payload.hook_event_name ?? '';
  if (session.kind === 'unowned') {
    deps.debug?.(`[hook] graph session ${event} dropped: ${session.why}`);
    deps.observe('graph-ignored');
    return { admitted: false };
  }
  const { owner } = session;
  if (event !== 'UsageUpdate') {
    deps.debug?.(`[hook] graph ${owner.graphRunId} ${owner.role} ${owner.runId}: ${event} ignored (a graph session admits only UsageUpdate)`);
    deps.observe('graph-ignored');
    return { admitted: false };
  }
  deps.observe('graph-usage');
  if (ingestGraphUsage(store, payload, owner, deps)) deps.notify?.(owner.ticketId);
  return { admitted: true, ticketId: owner.ticketId };
}
