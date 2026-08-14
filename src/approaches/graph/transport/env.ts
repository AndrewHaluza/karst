/**
 * Environment contract for graph sessions (Slice 3 Task 6).
 *
 * Host-owned values only. `KARST_TICKET_ID` keeps its meaning. `KARST_LAUNCH_ID`
 * carries the NODE-run id (or planner-run id), so `ui/terminalIdentity.ts`
 * re-identifies revived terminals WITHOUT modification — it carries the value
 * opaquely, which is why the key was reused rather than replaced. Two id
 * namespaces (legacy session ids and graph run ids) therefore share one key,
 * and the discriminator is `KARST_GRAPH_RUN_ID`'s PRESENCE: set on every
 * graph session and on no legacy one. Any consumer that RESOLVES the id
 * checks the discriminator first (`isGraphSessionEnv`), and a lookup that
 * misses reports not-found (`graphRunIdFromEnv` → undefined) rather than
 * falling through to the other namespace.
 *
 * Graph values use new names: `KARST_GRAPH_RUN_ID`, `KARST_GRAPH_REVISION_ID`,
 * `KARST_GRAPH_GENERATION`, `KARST_GRAPH_CAPABILITY`, `KARST_GRAPH_ARTIFACT_ROOT`,
 * `KARST_GRAPH_CALLBACK_URL`, `KARST_GRAPH_CALLBACK_TOKEN`, `KARST_GRAPH_CLI`,
 * `KARST_GRAPH_DB`, `KARST_GRAPH_PROJECT`. No other
 * key's meaning changes.
 */

/** The discriminator: present on every graph session, on no legacy one. */
export const KARST_GRAPH_RUN_ENV = 'KARST_GRAPH_RUN_ID';

export interface GraphSessionEnvInput {
  ticketId: number;
  /** The node-run id (or planner-run id) — rides `KARST_LAUNCH_ID`. */
  launchId: number;
  graphRunId: number;
  /** Node sessions only; 0 omits the key (a planner session has no revision). */
  revisionId: number;
  generation: string;
  /** The plaintext completion capability (never logged, never rendered). */
  capability: string;
  artifactRoot: string;
  callbackUrl: string;
  callbackToken: string;
  cliPath: string;
  dbPath: string;
  projectId: number;
}

/** Compose the graph session environment from host-owned values. */
export function buildGraphSessionEnv(input: GraphSessionEnvInput): Record<string, string> {
  const env: Record<string, string> = {
    KARST_TICKET_ID: String(input.ticketId),
    KARST_LAUNCH_ID: String(input.launchId),
    [KARST_GRAPH_RUN_ENV]: String(input.graphRunId),
    KARST_GRAPH_GENERATION: input.generation,
    KARST_GRAPH_CAPABILITY: input.capability,
    KARST_GRAPH_ARTIFACT_ROOT: input.artifactRoot,
    KARST_GRAPH_CALLBACK_URL: input.callbackUrl,
    KARST_GRAPH_CALLBACK_TOKEN: input.callbackToken,
    KARST_GRAPH_CLI: input.cliPath,
    KARST_GRAPH_DB: input.dbPath,
    KARST_GRAPH_PROJECT: String(input.projectId),
  };
  if (input.revisionId > 0) env.KARST_GRAPH_REVISION_ID = String(input.revisionId);
  return env;
}

/**
 * The discriminator check every id-resolving consumer must make FIRST: a
 * `KARST_LAUNCH_ID` with a `KARST_GRAPH_RUN_ID` present is a NODE/PLANNER
 * run id; without it, it is a legacy session id. Absent → false.
 */
export function isGraphSessionEnv(
  env: Readonly<Record<string, string | undefined>> | undefined,
): boolean {
  const raw = env?.[KARST_GRAPH_RUN_ENV];
  return typeof raw === 'string' && raw.length > 0;
}

/**
 * Resolve the graph run id from a graph session environment. Returns
 * undefined — NOT a fall-through to the legacy namespace — when the
 * discriminator is absent or the value is not a positive integer.
 */
export function graphRunIdFromEnv(
  env: Readonly<Record<string, string | undefined>> | undefined,
): number | undefined {
  if (!isGraphSessionEnv(env)) return undefined;
  const raw = env![KARST_GRAPH_RUN_ENV]!;
  return /^[1-9]\d*$/.test(raw) ? Number(raw) : undefined;
}
