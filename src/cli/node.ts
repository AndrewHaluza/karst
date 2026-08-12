/**
 * `karst node complete | block | replan` — a closed parse path (Slice 3 Task 5).
 *
 * A SEPARATE parser from `stage` AND from `graph submit`. It accepts only the
 * verb and a bounded `--reason` for `block`/`replan`. It accepts NO ticket,
 * graph, revision, or node id, destination, profile, provider, model, effort,
 * artifact root, callback URL, timestamp, capability, or generation in argv;
 * trailing argv is rejected, not ignored. The invoking agent reads ticket
 * content it did not author, so prompt injection reaches argv — every
 * identity claim comes from the host-owned environment, and the capability
 * hash is the sole authenticator.
 *
 * The outcome is validated against the PINNED node definition in the active
 * revision (the verb must map to a declared outcome). Evidence text is capped
 * and collapsed and is prefixed `[agent-reported]` in every rendering (the
 * constant is exported for the renderers); it is never a routing label.
 *
 * The capability is consumed one-shot on the FIRST mutating verb: a `block`
 * then `complete` gets an idempotent rejection of the second call. Duplicate,
 * stale, wrong-project, wrong-attempt, wrong-capability, and valid-but-late
 * completions are idempotent rejections: evidence recorded, no state change.
 * Durable state commits before any wake-up.
 *
 * Replan precondition (Decision 27): honored only when the activation's
 * causal lineage contains at least one observable precondition — a failed
 * deterministic command/gate outcome, `resource-claim-violated`, or
 * `integration-conflict`. A replan with no such evidence, including one whose
 * lineage contains only its own prior `blocked`, is recorded as evidence and
 * treated as `blocked`.
 *
 * This module never imports the workflow machine and produces no `Verdict`.
 */

import { createHash } from 'node:crypto';
import type { Store } from '../store/db.js';
import { parseGraphDocument, type ApproachNode } from '../approaches/graph/parse.js';

/** Evidence cap: reason text is bounded before it reaches any rendering. */
export const MAX_REASON_CHARS = 2000;
/** Prefix applied to agent-reported evidence in every rendering. */
export const AGENT_REPORTED_PREFIX = '[agent-reported]';

/** Host-owned environment identity for a node completion (untrusted claims). */
export interface NodeCompletionEnv {
  /** KARST_GRAPH_PROJECT — the numeric projects.id (untrusted claim). */
  project: string;
  /** KARST_TICKET_ID — the ticket id (untrusted claim). */
  ticketId: string;
  /** KARST_GRAPH_RUN_ID — the graph run id (untrusted claim). */
  graphRunId: string;
  /** KARST_LAUNCH_ID — the NODE-run id (untrusted claim). */
  nodeRunId: string;
  /** KARST_GRAPH_GENERATION — the launch generation (untrusted claim). */
  generation: string;
  /** KARST_GRAPH_CAPABILITY — the plaintext bearer capability. */
  capability: string;
}

export const NODE_COMPLETION_ENV_KEYS = [
  'KARST_GRAPH_PROJECT',
  'KARST_TICKET_ID',
  'KARST_GRAPH_RUN_ID',
  'KARST_LAUNCH_ID',
  'KARST_GRAPH_GENERATION',
  'KARST_GRAPH_CAPABILITY',
] as const;

export type NodeVerb = 'complete' | 'block' | 'replan';

export type NodeCompletionRejection =
  | 'unknown-run'
  | 'not-running'
  | 'duplicate-submission'
  | 'stale-generation'
  | 'wrong-capability'
  | 'wrong-project'
  | 'wrong-attempt'
  | 'unknown-outcome';

export type NodeCompletionResult =
  | { ok: true; nodeRunId: number; verb: NodeVerb; outcome: string }
  | { ok: false; rejected: NodeCompletionRejection; reason: string };

/** The observable preconditions that qualify a `replan` (Decision 27). */
export const REPLAN_QUALIFYING_OUTCOMES: ReadonlySet<string> = new Set([
  'failed',
  'not-matched',
  'infrastructure-error',
  'resource-claim-violated',
  'integration-conflict',
]);

/** SHA-256 over UTF-8 bytes — the capability hash. */
export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Cap and collapse untrusted evidence text (never a routing label). */
export function sanitizeEvidence(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const collapsed = raw.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (collapsed.length === 0) return undefined;
  return collapsed.length <= MAX_REASON_CHARS ? collapsed : collapsed.slice(0, MAX_REASON_CHARS);
}

export interface ParsedNodeCommand {
  verb: NodeVerb;
  reason: string | undefined;
}

/**
 * Parse `['node', '<verb>']` at the system boundary. Only the verb and a
 * bounded `--reason` for `block`/`replan`; trailing argv is rejected.
 */
export function parseNodeArgs(argv: string[]): ParsedNodeCommand {
  const [cmd, verb, ...rest] = argv;
  if (cmd !== 'node') {
    throw new Error(`expected 'node' command, got '${cmd ?? ''}'`);
  }
  if (verb !== 'complete' && verb !== 'block' && verb !== 'replan') {
    throw new Error(`unknown node verb '${verb ?? ''}' (complete|block|replan)`);
  }
  let reason: string | undefined;
  if (rest.length > 0) {
    if (rest[0] !== '--reason' || rest.length > 2) {
      throw new Error(`node ${verb} takes at most --reason <text> (got '${rest.join(' ')}')`);
    }
    reason = rest[1];
    if (reason === undefined || reason.length > MAX_REASON_CHARS) {
      throw new Error(`--reason must be at most ${MAX_REASON_CHARS} characters`);
    }
  }
  if (verb === 'complete' && reason !== undefined) {
    throw new Error('node complete takes no --reason');
  }
  return { verb, reason: sanitizeEvidence(reason) };
}

/** Read the host-owned environment claims; fails closed naming the first
 *  missing key. Project identity is required — there is no unscoped fallback. */
export function readNodeCompletionEnv(
  env: Record<string, string | undefined>,
): NodeCompletionEnv {
  const get = (key: (typeof NODE_COMPLETION_ENV_KEYS)[number]): string => {
    const value = env[key];
    if (value === undefined || value === '') {
      throw new Error(`node completion requires ${key} in the environment`);
    }
    return value;
  };
  return {
    project: get('KARST_GRAPH_PROJECT'),
    ticketId: get('KARST_TICKET_ID'),
    graphRunId: get('KARST_GRAPH_RUN_ID'),
    nodeRunId: get('KARST_LAUNCH_ID'),
    generation: get('KARST_GRAPH_GENERATION'),
    capability: get('KARST_GRAPH_CAPABILITY'),
  };
}

interface NodeRunRow {
  id: number;
  graph_run_id: number;
  revision_id: number;
  node_id: string;
  status: string;
  generation: string | null;
  capability_hash: string | null;
}

/** The pinned node definition from the active revision, or undefined. */
function pinnedNode(store: Store, nodeRun: NodeRunRow): ApproachNode | undefined {
  const revision = store.db
    .prepare(
      'SELECT canonical_graph FROM approach_graph_revisions WHERE id = ? AND status = \'active\'',
    )
    .get(nodeRun.revision_id) as { canonical_graph: string } | undefined;
  if (!revision) return undefined;
  const parsed = parseGraphDocument(revision.canonical_graph);
  if (!parsed.ok) return undefined;
  return parsed.document.nodes.find((n) => n.id === nodeRun.node_id);
}

/** Whether the activation's causal lineage contains an observable
 *  precondition (a failed deterministic command/gate outcome,
 *  `resource-claim-violated`, or `integration-conflict`). Walks the source
 *  run chain of the activation's claiming token. */
export function hasQualifyingPrecondition(store: Store, nodeRunId: number): boolean {
  let runId: number | null = nodeRunId;
  const seen = new Set<number>();
  while (runId !== null && !seen.has(runId)) {
    seen.add(runId);
    const token = store.db
      .prepare('SELECT source_node_run_id FROM approach_graph_tokens WHERE claiming_node_run_id = ? LIMIT 1')
      .get(runId) as { source_node_run_id: number | null } | undefined;
    if (!token || token.source_node_run_id === null) break;
    const prior = store.db
      .prepare('SELECT outcome FROM approach_node_runs WHERE id = ?')
      .get(token.source_node_run_id) as { outcome: string | null } | undefined;
    if (prior?.outcome && REPLAN_QUALIFYING_OUTCOMES.has(prior.outcome)) return true;
    runId = token.source_node_run_id;
  }
  return false;
}

/** The one conditional UPDATE that authenticates and records the outcome.
 *  Affected rows 1 = success; 0 = idempotent rejection, no state change. */
function nodeUpdate(
  store: Store,
  env: NodeCompletionEnv,
  target: { status: string; outcome: string; reason: string | undefined; endedAt: string },
): boolean {
  return store.db
    .prepare(
      `UPDATE approach_node_runs
       SET status = ?, outcome = ?, reason = ?, ended_at = ?
       WHERE id = ? AND status = 'running'
         AND graph_run_id = ?
         AND generation = ?
         AND capability_hash = ?
         AND EXISTS (
           SELECT 1
           FROM approach_graph_runs gr
           JOIN tickets t ON t.id = gr.ticket_id
           WHERE gr.id = approach_node_runs.graph_run_id
             AND gr.id = ?
             AND t.project_id = ?
         )
         AND NOT EXISTS (
           -- Wrong-attempt: an impl stage row whose attempt differs from the
           -- graph run's means the ticket moved past this run's attempt. A
           -- ticket with no impl row yet is accepted (cannot be disproven).
           SELECT 1 FROM stages st
           WHERE st.ticket_id = ? AND st.stage_key = 'impl'
             AND st.attempt != (
               SELECT gr2.stage_attempt FROM approach_graph_runs gr2
               WHERE gr2.id = approach_node_runs.graph_run_id
             )
         )`,
    )
    .run(
      target.status,
      target.outcome,
      target.reason ?? null,
      target.endedAt,
      Number(env.nodeRunId),
      Number(env.graphRunId),
      env.generation,
      sha256Hex(new TextEncoder().encode(env.capability)),
      Number(env.graphRunId),
      Number(env.project),
      Number(env.ticketId),
    ).changes === 1;
}

/** Name the rejection after the failed conditional update (read-only). */
function rejectionKind(store: Store, env: NodeCompletionEnv): NodeCompletionRejection {
  const nodeRun = store.db
    .prepare('SELECT * FROM approach_node_runs WHERE id = ?')
    .get(Number(env.nodeRunId)) as NodeRunRow | undefined;
  if (!nodeRun || nodeRun.graph_run_id !== Number(env.graphRunId)) return 'unknown-run';
  if (nodeRun.status !== 'running') {
    return nodeRun.status === 'completing' || nodeRun.status === 'blocked' ||
      nodeRun.status === 'completed'
      ? 'duplicate-submission'
      : 'not-running';
  }
  if (nodeRun.generation !== env.generation) return 'stale-generation';
  if (nodeRun.capability_hash !== sha256Hex(new TextEncoder().encode(env.capability))) {
    return 'wrong-capability';
  }
  const graphRun = store.db
    .prepare(
      `SELECT gr.stage_attempt AS stage_attempt, t.project_id AS project_id
       FROM approach_graph_runs gr JOIN tickets t ON t.id = gr.ticket_id
       WHERE gr.id = ?`,
    )
    .get(Number(env.graphRunId)) as { stage_attempt: number; project_id: number | null } | undefined;
  if (!graphRun) return 'unknown-run';
  if (graphRun.project_id !== Number(env.project)) return 'wrong-project';
  const currentAttempt = store.db
    .prepare(
      `SELECT MAX(attempt) AS attempt FROM stages WHERE ticket_id = ? AND stage_key = 'impl'`,
    )
    .get(Number(env.ticketId)) as { attempt: number | null };
  if (currentAttempt.attempt !== null && currentAttempt.attempt !== graphRun.stage_attempt) {
    return 'wrong-attempt';
  }
  return 'unknown-run';
}

/**
 * Run `karst node <verb>`. Validates the verb against the pinned node
 * definition, applies the replan precondition, then the capability-
 * authenticated conditional UPDATE. Durable state commits before any wake-up;
 * a rejection records its evidence in the returned result and changes nothing.
 */
export function runNodeCommand(
  store: Store,
  env: Record<string, string | undefined>,
  argv: string[],
  now: () => string = () => new Date().toISOString(),
): string {
  const parsed = parseNodeArgs(argv);
  const parsedEnv = readNodeCompletionEnv(env);

  const nodeRun = store.db
    .prepare('SELECT * FROM approach_node_runs WHERE id = ?')
    .get(Number(parsedEnv.nodeRunId)) as NodeRunRow | undefined;
  if (!nodeRun || nodeRun.graph_run_id !== Number(parsedEnv.graphRunId)) {
    return JSON.stringify({ ok: false, rejected: 'unknown-run', reason: 'node run not found' });
  }
  const node = pinnedNode(store, nodeRun);
  if (!node) {
    return JSON.stringify({
      ok: false,
      rejected: 'unknown-outcome',
      reason: `node "${nodeRun.node_id}" has no pinned definition in the active revision`,
    });
  }
  const declared = new Set(node.outcomes);
  const outcomeForVerb: Record<NodeVerb, 'complete' | 'blocked' | 'replan'> = {
    complete: 'complete',
    block: 'blocked',
    replan: 'replan',
  };
  if (!declared.has(outcomeForVerb[parsed.verb])) {
    return JSON.stringify({
      ok: false,
      rejected: 'unknown-outcome',
      reason: `verb ${parsed.verb} maps to outcome "${outcomeForVerb[parsed.verb]}", not declared by node "${nodeRun.node_id}"`,
    });
  }

  // Replan precondition (Decision 27): without an observable precondition in
  // the causal lineage, a replan request is recorded as evidence and treated
  // as `blocked` — it never routes a replan on its own report.
  let outcome = outcomeForVerb[parsed.verb];
  const replanHonored =
    parsed.verb === 'replan' && hasQualifyingPrecondition(store, nodeRun.id);
  const reason =
    parsed.verb === 'replan' && !replanHonored
      ? sanitizeEvidence(`replan requested without an observable precondition; treated as blocked${parsed.reason ? `: ${parsed.reason}` : ''}`)
      : parsed.reason;
  if (parsed.verb === 'replan' && !replanHonored) outcome = 'blocked';

  const committed = store.db.transaction(() =>
    nodeUpdate(
      store,
      parsedEnv,
      {
        status: outcome === 'complete' ? 'completing' : 'blocked',
        outcome,
        reason,
        endedAt: now(),
      },
    ),
  )();
  if (!committed) {
    const rejected = rejectionKind(store, parsedEnv);
    return JSON.stringify({
      ok: false,
      rejected,
      reason: `node ${parsed.verb} rejected: ${rejected}`,
    });
  }
  return JSON.stringify({
    ok: true,
    nodeRunId: Number(parsedEnv.nodeRunId),
    verb: parsed.verb,
    outcome,
  });
}
