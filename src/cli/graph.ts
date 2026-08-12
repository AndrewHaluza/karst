/**
 * `karst graph submit` — a separate closed parse path (Slice 2 Task 6).
 *
 * The invoking agent reads ticket content it did not author, so prompt
 * injection reaches argv. Parser separation is the security property (the
 * repository's existing `parseStageArgs` doctrine): this parser accepts NO
 * ticket key/id, stage, attempt, graph/revision/run id, destination, profile,
 * provider, model, effort, artifact root, callback address, timestamp,
 * capability, or launch generation in argv. Every one of those comes from the
 * host-owned environment. Trailing argv is rejected, not ignored.
 *
 * Authentication is a single conditional UPDATE requiring project, ticket,
 * stage attempt (through the graph run), graph run, planner run, generation,
 * status `running`, and the capability HASH to match one row. Environment
 * identity fields are untrusted claims; the capability hash is the sole
 * authenticator. The capability is a CSPRNG bearer secret of at least 256
 * bits; SQLite stores only its hash; the plaintext lives only in the
 * supervised process environment. The `running → submitted` transition
 * consumes it one-shot.
 *
 * This module never imports the workflow machine and produces no `Verdict`.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Store } from '../store/db.js';

/** The fixed planner artifact the host assigns; submit reads only this. */
export const PLANNER_GRAPH_JSON = 'graph.json';

/** Host-owned environment identity for a graph submit (untrusted claims). */
export interface GraphSubmitEnv {
  /** KARST_GRAPH_PROJECT — the numeric projects.id (untrusted claim). */
  project: string;
  /** KARST_TICKET_ID — the ticket id (untrusted claim). */
  ticketId: string;
  /** KARST_GRAPH_RUN_ID — the graph run id (untrusted claim). */
  graphRunId: string;
  /** KARST_LAUNCH_ID — the planner-run id (untrusted claim). */
  plannerRunId: string;
  /** KARST_GRAPH_GENERATION — the launch generation (untrusted claim). */
  generation: string;
  /** KARST_GRAPH_CAPABILITY — the plaintext bearer capability. */
  capability: string;
  /** KARST_GRAPH_ARTIFACT_ROOT — the fixed artifact root. */
  artifactRoot: string;
}

export const GRAPH_SUBMIT_ENV_KEYS = [
  'KARST_GRAPH_PROJECT',
  'KARST_TICKET_ID',
  'KARST_GRAPH_RUN_ID',
  'KARST_LAUNCH_ID',
  'KARST_GRAPH_GENERATION',
  'KARST_GRAPH_CAPABILITY',
  'KARST_GRAPH_ARTIFACT_ROOT',
] as const;

export type GraphSubmitRejection =
  | 'unknown-run'
  | 'not-running'
  | 'duplicate-submission'
  | 'stale-generation'
  | 'wrong-capability'
  | 'wrong-project';

export type GraphSubmitResult =
  | { ok: true; graphRunId: number; plannerRunId: number; graphSnapshotId: string }
  | { ok: false; rejected: GraphSubmitRejection; reason: string };

/** SHA-256 over UTF-8 bytes; used for the capability hash and snapshots. */
export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export interface ParsedGraph {
  verb: 'submit';
}

/**
 * Parse `['graph', 'submit']` at the system boundary. No path, no outcome, no
 * flags; trailing argv is rejected, not ignored.
 */
export function parseGraphArgs(argv: string[]): ParsedGraph {
  const [cmd, verb, ...trailing] = argv;
  if (cmd !== 'graph') {
    throw new Error(`expected 'graph' command, got '${cmd ?? ''}'`);
  }
  if (verb !== 'submit') {
    throw new Error(`unknown graph verb '${verb ?? ''}' (submit only)`);
  }
  if (trailing.length > 0) {
    throw new Error(`graph submit takes no arguments (got '${trailing.join(' ')}')`);
  }
  return { verb: 'submit' };
}

/**
 * Read the host-owned environment claims; fails closed naming the first
 * missing key. Project identity is required — there is no unscoped fallback.
 */
export function readGraphSubmitEnv(
  env: Record<string, string | undefined>,
): GraphSubmitEnv {
  const get = (key: (typeof GRAPH_SUBMIT_ENV_KEYS)[number]): string => {
    const value = env[key];
    if (value === undefined || value === '') {
      throw new Error(`graph submit requires ${key} in the environment`);
    }
    return value;
  };
  return {
    project: get('KARST_GRAPH_PROJECT'),
    ticketId: get('KARST_TICKET_ID'),
    graphRunId: get('KARST_GRAPH_RUN_ID'),
    plannerRunId: get('KARST_LAUNCH_ID'),
    generation: get('KARST_GRAPH_GENERATION'),
    capability: get('KARST_GRAPH_CAPABILITY'),
    artifactRoot: get('KARST_GRAPH_ARTIFACT_ROOT'),
  };
}

/**
 * The one conditional UPDATE that both authenticates and marks the submission.
 * Affected rows 1 = success; 0 = idempotent rejection with no state change.
 * The capability HASH is the sole authenticator; the project/ticket/stage
 * attempt claims are structural joins through the graph run.
 */
function submitUpdate(
  store: Store,
  env: GraphSubmitEnv,
  graphSnapshotId: string,
  now: string,
): boolean {
  return store.db
    .prepare(
      `UPDATE approach_planner_runs
       SET status = 'submitted', graph_snapshot_id = ?, submitted_at = ?
       WHERE id = ? AND status = 'running'
         AND graph_run_id = ?
         AND generation = ?
         AND capability_hash = ?
         AND EXISTS (
           SELECT 1
           FROM approach_graph_runs gr
           JOIN tickets t ON t.id = gr.ticket_id
           WHERE gr.id = approach_planner_runs.graph_run_id
             AND gr.id = ?
             AND t.project_id = ?
         )`,
    )
    .run(
      graphSnapshotId,
      now,
      Number(env.plannerRunId),
      Number(env.graphRunId),
      env.generation,
      sha256Hex(new TextEncoder().encode(env.capability)),
      Number(env.graphRunId),
      Number(env.project),
    ).changes === 1;
}

/** Name the rejection after the failed conditional update (read-only). */
function rejectionKind(store: Store, env: GraphSubmitEnv): GraphSubmitRejection {
  const plannerRun = store.db
    .prepare('SELECT * FROM approach_planner_runs WHERE id = ?')
    .get(Number(env.plannerRunId)) as
    | { status: string; graph_run_id: number; generation: string | null; capability_hash: string | null }
    | undefined;
  if (!plannerRun || plannerRun.graph_run_id !== Number(env.graphRunId)) {
    return 'unknown-run';
  }
  if (plannerRun.status === 'submitted') return 'duplicate-submission';
  if (plannerRun.status !== 'running') return 'not-running';
  if (plannerRun.generation !== env.generation) return 'stale-generation';
  if (plannerRun.capability_hash !== sha256Hex(new TextEncoder().encode(env.capability))) {
    return 'wrong-capability';
  }
  const graphRun = store.db
    .prepare(
      `SELECT t.project_id AS project_id
       FROM approach_graph_runs gr JOIN tickets t ON t.id = gr.ticket_id
       WHERE gr.id = ?`,
    )
    .get(Number(env.graphRunId)) as { project_id: number | null } | undefined;
  if (!graphRun || graphRun.project_id !== Number(env.project)) return 'wrong-project';
  return 'unknown-run';
}

/**
 * Run `karst graph submit`. Reads and snapshots the fixed planner artifact,
 * then applies the capability-authenticated conditional UPDATE. Durable state
 * commits before any wake-up; a rejection records its evidence in the
 * returned result and changes nothing.
 */
export function runGraphCommand(
  store: Store,
  env: Record<string, string | undefined>,
  argv: string[],
  now: () => string = () => new Date().toISOString(),
): string {
  parseGraphArgs(argv);
  const parsed = readGraphSubmitEnv(env);

  const artifactPath = join(parsed.artifactRoot, PLANNER_GRAPH_JSON);
  let graphBytes: Uint8Array;
  try {
    graphBytes = new Uint8Array(readFileSync(artifactPath));
  } catch {
    throw new Error(`graph submit cannot read the planner artifact at ${artifactPath}`);
  }
  const graphSnapshotId = sha256Hex(graphBytes);
  const snapshotDir = join(parsed.artifactRoot, 'snapshots');
  mkdirSync(snapshotDir, { recursive: true });
  writeFileSync(join(snapshotDir, `${graphSnapshotId}.json`), graphBytes);

  const committed = store.db.transaction(() =>
    submitUpdate(store, parsed, graphSnapshotId, now()),
  )();
  if (!committed) {
    const rejected = rejectionKind(store, parsed);
    return JSON.stringify({
      ok: false,
      rejected,
      reason: `graph submit rejected: ${rejected}`,
    });
  }
  return JSON.stringify({
    ok: true,
    graphRunId: Number(parsed.graphRunId),
    plannerRunId: Number(parsed.plannerRunId),
    graphSnapshotId,
  });
}
