/**
 * The graph launch id (T1370).
 *
 * A ticket session's `karstLaunch` is a `randomUUID()` generation: dispatch
 * compares it with `recoveryLifecycle`'s active launch and drops a stale one.
 * A graph planner or node session is not launched by a ticket generation at
 * all — the ticket may have no session — so passing a UUID would read as a
 * stale ticket launch and every graph hook would be dropped, while passing
 * nothing leaves the event indistinguishable from the ticket's own session
 * (a planner runs in the ticket worktree).
 *
 * So a graph session carries an id of its own SHAPE: a fixed `graph-` prefix,
 * the run it belongs to, and the run's launch `generation` (a UUID). The hook
 * endpoint treats the launch id as its shared secret, so the run ids alone
 * (guessable) are not enough: the generation suffix is the secret part, and
 * dispatch checks it against the run row's persisted `generation`.
 * `parseGraphLaunchId` is the only reader; a malformed or foreign id parses to
 * null and is treated as not-graph, never as a half-read id.
 *
 * Host-agnostic and vscode-free: the transport's `hookChannelFor` builds it,
 * dispatch parses it.
 */

/** What a graph launch id names: the run and whether it is the planner's. */
export type GraphLaunchRole = 'planner' | 'node';

export interface GraphLaunchParts {
  graphRunId: number;
  /** The planner-run id or the node-run id — the two tables have independent
   *  sequences, so `role` is what tells them apart. */
  runId: number;
  role: GraphLaunchRole;
  /** The run's launch generation (a UUID, persisted on the run row). */
  generation: string;
}

/** The fixed prefix that marks an id as the graph's (a ticket generation is a
 *  bare UUID, so it can never collide). */
export const GRAPH_LAUNCH_PREFIX = 'graph-';

/** The UUID form of a launch generation (the ticket launch id has the same form). */
const UUID_SOURCE = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
const UUID_PATTERN = new RegExp(`^${UUID_SOURCE}$`);
const GRAPH_LAUNCH_PATTERN = new RegExp(`^graph-(\\d+)-(planner|node)-(\\d+)-(${UUID_SOURCE})$`);

/** A part a launch id can carry. Refused rather than stringified, because an id
 *  that cannot be parsed back is useless to the reader. */
function requireRunId(value: number, field: string): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`graphLaunchId: ${field} must be a non-negative integer, got ${String(value)}`);
  }
  return value;
}

/** Build the id for a graph launch. */
export function graphLaunchId(input: GraphLaunchParts): string {
  const graphRunId = requireRunId(input.graphRunId, 'graphRunId');
  const runId = requireRunId(input.runId, 'runId');
  if (!UUID_PATTERN.test(input.generation)) {
    throw new RangeError('graphLaunchId: generation must be a UUID');
  }
  return `${GRAPH_LAUNCH_PREFIX}${graphRunId}-${input.role}-${runId}-${input.generation}`;
}

/**
 * The id for a launch REQUEST: `runKind` is already on the request
 * (`SupervisedLaunchRequest.runKind`), so no caller has to re-derive the role.
 * Absent `runKind` is a node launch, the default in `AgentNodeLaunch`.
 */
export function graphLaunchIdForLaunch(request: {
  graphRunId: number;
  nodeRunId: number;
  runKind?: GraphLaunchRole;
  generation: string;
}): string {
  return graphLaunchId({
    graphRunId: request.graphRunId,
    runId: request.nodeRunId,
    role: request.runKind === 'planner' ? 'planner' : 'node',
    generation: request.generation,
  });
}

/** Read a launch id back; null for anything that is not exactly one. */
export function parseGraphLaunchId(value: string | null | undefined): GraphLaunchParts | null {
  if (typeof value !== 'string') return null;
  const match = GRAPH_LAUNCH_PATTERN.exec(value);
  if (!match) return null;
  const graphRunId = Number(match[1]);
  const runId = Number(match[3]);
  if (!Number.isSafeInteger(graphRunId) || !Number.isSafeInteger(runId)) return null;
  return { graphRunId, runId, role: match[2] as GraphLaunchRole, generation: match[4]! };
}

/** True when the string is a graph launch id. */
export function isGraphLaunchId(value: string | null | undefined): boolean {
  return parseGraphLaunchId(value) !== null;
}
