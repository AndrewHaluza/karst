/**
 * Host-side builder for the graph Inside projection (Slice 3 Task 11).
 *
 * `buildDashboardState` never reads the graph tables; the host injects the
 * finished `GraphInsideInput` through this builder. It is a READ over rows
 * the coordinator already keeps current — graph run, planner runs, node runs,
 * the active revision, artifact instances, live transport sessions, and the
 * per-node override rows (Slice 6 T4) — plus the manifest's `graph.limits`
 * for the execution policy. Host-agnostic: store, manifest getter, live-session
 * source and clock are injected.
 *
 * `liveSessions` is the transport's own registry (graph sessions bypass
 * SessionManager); a session's kind is decided by which run table its row
 * lives in — the id is a recorded row id, never a client-supplied name.
 */

import type { Store } from '../../store/db.js';
import { DEFAULT_GRAPH_LIMITS } from '../../manifest/graphConfig.js';
import type { Manifest } from '../../manifest/types.js';
import type { GraphInsideInput } from '../../model/inside/graph.js';
import type { SupervisedAgentSession } from '../../approaches/graph/transport/agentTransport.js';
import { NODE_OVERRIDE_KINDS } from '../../store/graph/nodeRuns.js';

export interface GraphInsideDeps {
  store: Store;
  /** Live manifest getter — the execution policy resolves from it. */
  manifest: () => Manifest | undefined;
  /** The supervised transport's live sessions (empty when none). */
  liveSessions: () => SupervisedAgentSession[];
  now: () => string;
}

interface GraphRunRow {
  id: number;
  stage_attempt: number;
  approach_id: string;
  status: string;
  created_at: string;
}

/** The latest graph run of the ticket, or undefined. */
export function latestGraphRunFor(
  store: Store,
  ticketId: number,
): GraphRunRow | undefined {
  return store.db
    .prepare(
      `SELECT id, stage_attempt, approach_id, status, created_at
         FROM approach_graph_runs WHERE ticket_id = ? ORDER BY id DESC LIMIT 1`,
    )
    .get(ticketId) as GraphRunRow | undefined;
}

/** The 1-based ordinal of `runId` among the ticket's OWN graph runs — the
 *  display number, never the global row id. A fresh ticket's first run reads
 *  `run 1`, whatever `approach_graph_runs.id` the registry has reached. */
export function graphRunOrdinal(store: Store, ticketId: number, runId: number): number {
  const row = store.db
    .prepare('SELECT COUNT(*) AS n FROM approach_graph_runs WHERE ticket_id = ? AND id <= ?')
    .get(ticketId, runId) as { n: number };
  return row.n;
}

/** Which run table a session's row id lives in — `node`, `planner`, or
 *  neither (a row deleted since the session launched → the session is not
 *  offered, because its kind cannot be proven). */
function sessionKindFor(
  store: Store,
  graphRunId: number,
  runId: number,
): 'node' | 'planner' | null {
  const node = store.db
    .prepare('SELECT 1 AS x FROM approach_node_runs WHERE id = ? AND graph_run_id = ?')
    .get(runId, graphRunId);
  if (node) return 'node';
  const planner = store.db
    .prepare('SELECT 1 AS x FROM approach_planner_runs WHERE id = ? AND graph_run_id = ?')
    .get(runId, graphRunId);
  return planner ? 'planner' : null;
}

export function buildGraphInsideInput(
  deps: GraphInsideDeps,
  ticketId: number,
): GraphInsideInput | null {
  const run = latestGraphRunFor(deps.store, ticketId);
  if (!run) return null;

  const plannerRuns = deps.store.db
    .prepare(
      `SELECT planner_run_number, kind, status, compile_attempt, reason,
              started_at, submitted_at, ended_at
         FROM approach_planner_runs WHERE graph_run_id = ? ORDER BY planner_run_number`,
    )
    .all(run.id) as {
    planner_run_number: number;
    kind: 'bootstrap' | 'replan';
    status: string;
    compile_attempt: number;
    reason: string | null;
    started_at: string | null;
    submitted_at: string | null;
    ended_at: string | null;
  }[];

  const nodeRuns = deps.store.db
    .prepare(
      `SELECT id, node_id, node_kind, revision_id, visit_number, status, outcome, reason,
              provider, model, effort, profile, launch_attempt, started_at, ended_at
         FROM approach_node_runs WHERE graph_run_id = ? ORDER BY id`,
    )
    .all(run.id) as {
    id: number;
    node_id: string;
    node_kind: string;
    revision_id: number;
    visit_number: number;
    status: string;
    outcome: string | null;
    reason: string | null;
    provider: string | null;
    model: string | null;
    effort: string | null;
    profile: string | null;
    launch_attempt: number;
    started_at: string | null;
    ended_at: string | null;
  }[];

  // Slice 6 Task 4: existing per-node overrides — a READ over the store's
  // claim-gated override table. Grouped by (revision, node); kinds are
  // narrowed to the closed `NodeOverrideKind` vocabulary (the table's own CHECK
  // already enforces it; the read re-validates because the projection renders
  // the kinds into a marker). The projection treats this input as READ-ONLY.
  const overrideRows = deps.store.db
    .prepare(
      `SELECT revision_id, node_id, kind
         FROM approach_node_overrides WHERE graph_run_id = ? ORDER BY revision_id, node_id, kind`,
    )
    .all(run.id) as { revision_id: number; node_id: string; kind: string }[];
  const overrides = Array.from(
    overrideRows.reduce((byKey, row) => {
      if (!NODE_OVERRIDE_KINDS.includes(row.kind as (typeof NODE_OVERRIDE_KINDS)[number])) return byKey;
      const key = `${row.revision_id}:${row.node_id}`;
      const group = byKey.get(key) ?? { revisionId: row.revision_id, nodeId: row.node_id, kinds: [] as string[] };
      group.kinds.push(row.kind);
      byKey.set(key, group);
      return byKey;
    }, new Map<string, { revisionId: number; nodeId: string; kinds: string[] }>()),
    ([, group]) => group,
  );

  // Slice 5 Task 3: the deferral ledger, filtered to nodes whose token is
  // STILL pending — a deferral whose node was claimed, cancelled, or whose run
  // stopped is stale and never rendered (a READ-time filter, like the merged-PR
  // rule: nothing is deleted on transition, the read recomputes from state).
  const deferrals = deps.store.db
    .prepare(
      `SELECT d.node_id, d.reason, d.wait_since
         FROM approach_node_deferrals d
        WHERE d.graph_run_id = ?
          AND EXISTS (
            SELECT 1 FROM approach_graph_tokens t
             WHERE t.revision_id = d.revision_id
               AND t.destination_node_id = d.node_id
               AND t.status = 'pending'
          )
        ORDER BY d.node_id`,
    )
    .all(run.id) as {
    node_id: string;
    reason: string;
    wait_since: string;
  }[];

  const revision = deps.store.db
    .prepare(
      `SELECT revision_number, status, fingerprint
         FROM approach_graph_revisions
        WHERE graph_run_id = ? AND status = 'active'
        ORDER BY revision_number DESC LIMIT 1`,
    )
    .get(run.id) as
    | { revision_number: number; status: string; fingerprint: string }
    | undefined;

  const artifacts = deps.store.db
    .prepare(
      `SELECT artifact_id, media_type, byte_size, created_at
         FROM approach_artifact_instances WHERE graph_run_id = ? ORDER BY id`,
    )
    .all(run.id) as {
    artifact_id: string;
    media_type: string;
    byte_size: number;
    created_at: string;
  }[];

  const limits =
    deps
      .manifest()
      ?.approaches?.find((a) => a.id === run.approach_id)
      ?.graph?.limits ?? DEFAULT_GRAPH_LIMITS;

  const liveSessions = deps
    .liveSessions()
    .filter((s) => s.graphRunId === run.id)
    .flatMap((s) => {
      const kind = sessionKindFor(deps.store, run.id, s.nodeRunId);
      return kind === null ? [] : [{ kind, runId: s.nodeRunId }];
    });

  return {
    enabled: true,
    graphRun: {
      id: run.id,
      runNumber: graphRunOrdinal(deps.store, ticketId, run.id),
      status: run.status,
      approachId: run.approach_id,
      stageAttempt: run.stage_attempt,
      createdAt: run.created_at,
    },
    plannerRuns: plannerRuns.map((p) => ({
      plannerRunNumber: p.planner_run_number,
      kind: p.kind,
      status: p.status,
      compileAttempt: p.compile_attempt,
      reason: p.reason,
      startedAt: p.started_at,
      submittedAt: p.submitted_at,
      endedAt: p.ended_at,
    })),
    nodeRuns: nodeRuns.map((n) => ({
      nodeRunId: n.id,
      nodeId: n.node_id,
      nodeKind: n.node_kind,
      revisionId: n.revision_id,
      visitNumber: n.visit_number,
      status: n.status,
      outcome: n.outcome,
      reason: n.reason,
      provider: n.provider,
      model: n.model,
      effort: n.effort,
      profile: n.profile,
      launchAttempt: n.launch_attempt,
      startedAt: n.started_at,
      endedAt: n.ended_at,
    })),
    overrides,
    deferrals: deferrals.map((d) => ({
      nodeId: d.node_id,
      reason: d.reason,
      waitSince: d.wait_since,
    })),
    execution: { maxParallel: limits.maxParallel, maxNodeRuns: limits.maxNodeRuns },
    revision: revision
      ? {
          revisionNumber: revision.revision_number,
          status: revision.status,
          fingerprint: revision.fingerprint,
        }
      : null,
    diagnostics: [],
    artifacts: artifacts.map((a) => ({
      artifactId: a.artifact_id,
      byteSize: a.byte_size,
      mediaType: a.media_type,
      createdAt: a.created_at,
    })),
    liveSessions,
    now: deps.now(),
  };
}
