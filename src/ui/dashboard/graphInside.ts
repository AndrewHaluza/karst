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
import type { GraphBlockRecovery, GraphInsideInput } from '../../model/inside/graph.js';
import type { GraphTopology } from '../../model/inside/graphDag.js';
import { GRAPH_TEXT_MAX } from '../../model/inside/graphText.js';
import { summarizeRecordedTokenUsageByNodeRun } from '../../store/tokenUsage.js';
import type { SupervisedAgentSession } from '../../approaches/graph/transport/agentTransport.js';
import { NODE_OVERRIDE_KINDS, nodeRunGraphRunId, nodeRunsForGraphRunDisplay } from '../../store/graph/nodeRuns.js';
import {
  graphRunIdStatusBlockedReason,
  graphRunOrdinal as runOrdinal,
  graphRunStatusReplanCount,
  latestGraphRunForTicket,
} from '../../store/graph/graphRuns.js';
import type { GraphRunRow as FullGraphRunRow } from '../../store/graph/graphRuns.js';
import { plannerRunGraphRunId, plannerRunsForGraphRun } from '../../store/graph/plannerRuns.js';
import { activeRevision } from '../../store/graph/revisions.js';
import { parseGraphDocument } from '../../approaches/graph/parse.js';
import { recoveryCategoryFor } from '../../approaches/graph/coordinator/recovery.js';

export interface GraphInsideDeps {
  store: Store;
  /** Live manifest getter — the execution policy resolves from it. */
  manifest: () => Manifest | undefined;
  /** The supervised transport's live sessions (empty when none). */
  liveSessions: () => SupervisedAgentSession[];
  /** The run's dependency preflight warning (e.g. `deps: web not provided`), when it has one. */
  depsWarningOf?: (graphRunId: number) => string | undefined;
  now: () => string;
  /** Injected debug sink (CLAUDE.md debug rules); absent → silent. */
  debug?: (message: string) => void;
}

type GraphRunRow = Pick<
  FullGraphRunRow,
  'id' | 'stage_attempt' | 'approach_id' | 'status' | 'created_at' | 'blocked_reason'
>;

/** The latest graph run of the ticket, or undefined. */
export function latestGraphRunFor(
  store: Store,
  ticketId: number,
): GraphRunRow | undefined {
  return latestGraphRunForTicket(store.db, ticketId);
}

/** The 1-based ordinal of `runId` among the ticket's OWN graph runs — the
 *  display number, never the global row id. A fresh ticket's first run reads
 *  `run 1`, whatever `approach_graph_runs.id` the registry has reached. The
 *  query is the store's one definition (`store/graph/graphRuns.ts`); this
 *  re-export keeps the existing dashboard import path. */
export function graphRunOrdinal(store: Store, ticketId: number, runId: number): number {
  return runOrdinal(store.db, ticketId, runId);
}

/** Which run table a session's row id lives in — `node`, `planner`, or
 *  neither (a row deleted since the session launched → the session is not
 *  offered, because its kind cannot be proven). */
function sessionKindFor(
  store: Store,
  graphRunId: number,
  runId: number,
): 'node' | 'planner' | null {
  if (nodeRunGraphRunId(store.db, runId) === graphRunId) return 'node';
  if (plannerRunGraphRunId(store.db, runId) === graphRunId) return 'planner';
  return null;
}

const TOPOLOGY_MAX_BYTES = 256 * 1024;
const TOPOLOGY_MAX_NODES = 2000;
const TOPOLOGY_MAX_EDGES = 8000;
const TOPOLOGY_CACHE_SIZE = 16;

/** Per-store memo of parsed topologies keyed by revision fingerprint (the
 *  content hash), bounded to the last `TOPOLOGY_CACHE_SIZE`. `null` caches an
 *  unreadable graph. A WeakMap on the store keeps it host-agnostic and keeps
 *  one store's graphs from answering another's. */
const topologyMemo = new WeakMap<Store, Map<string, GraphTopology | null>>();

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}
const isId = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

/** Ids + edges of the compiled plan, read leniently: anything malformed is
 *  dropped, and an unreadable document yields no topology (the DAG view then
 *  simply does not render). Sizes are capped BEFORE mapping. A node's `label`
 *  and `instructionsArtifact` (kept as `task`) ride along for the node details
 *  card; a malformed one is dropped without dropping its node. */
function parseTopology(canonicalGraph: string): GraphTopology | undefined {
  let doc: unknown;
  try {
    doc = JSON.parse(canonicalGraph);
  } catch {
    return undefined;
  }
  if (!isRecord(doc) || !Array.isArray(doc.nodes)) return undefined;
  const nodes = (doc.nodes as unknown[])
    .slice(0, TOPOLOGY_MAX_NODES)
    .flatMap((n) =>
      isRecord(n) && isId(n.id)
        ? [
            {
              id: n.id,
              ...(typeof n.label === 'string' ? { label: n.label.slice(0, GRAPH_TEXT_MAX) } : {}),
              ...(isId(n.instructionsArtifact) ? { task: n.instructionsArtifact } : {}),
            },
          ]
        : [],
    );
  const edges = (Array.isArray(doc.edges) ? (doc.edges as unknown[]) : [])
    .slice(0, TOPOLOGY_MAX_EDGES)
    .flatMap((e) => (isRecord(e) && isId(e.from) && isId(e.to) ? [{ from: e.from, to: e.to }] : []));
  return nodes.length > 0 ? { nodes, edges } : undefined;
}

function readTopology(
  store: Store,
  revision: { fingerprint: string; graph_bytes: number } | undefined,
  debug: ((m: string) => void) | undefined,
  loadGraph: () => string | undefined,
): GraphTopology | undefined {
  if (!revision) return undefined;
  if (revision.graph_bytes > TOPOLOGY_MAX_BYTES) {
    debug?.(`[driver] graph topology skipped: compiled graph is ${revision.graph_bytes} bytes (cap ${TOPOLOGY_MAX_BYTES})`);
    return undefined;
  }
  const memo = topologyMemo.get(store) ?? new Map<string, GraphTopology | null>();
  topologyMemo.set(store, memo);
  const hit = memo.get(revision.fingerprint);
  if (hit !== undefined) return hit ?? undefined;
  const raw = loadGraph();
  const topology = raw ? parseTopology(raw) : undefined;
  if (!topology) debug?.('[driver] graph topology unreadable: compiled graph is not a node/edge document');
  if (memo.size >= TOPOLOGY_CACHE_SIZE) memo.delete(memo.keys().next().value as string);
  memo.set(revision.fingerprint, topology ?? null);
  return topology;
}

/**
 * Which recovery control actually works on a blocked graph run (T1359, D793).
 *
 * The blocked banner's primary action must not offer a Resume that
 * `recoverGraphRun` is guaranteed to refuse. Resume refuses every
 * `explicit-resolution` reason (`integration-conflict`,
 * `graph-topology-deadlock`, a null or unknown reason) and every
 * `config-then-resume` reason (a reparable block or a spent document budget),
 * and a `replan` / `compile-new-revision` block has nothing left to elect once
 * the revision's own `budgets.maxReplans` is spent. Everything else resumes.
 *
 * Reads the run, its accepted replan count and the ACTIVE revision's canonical
 * document — the same rows `electReplan` reads, parsed through the same
 * `parseGraphDocument`. A missing or unparseable revision leaves
 * `maxReplans: null`, so the run reads as resumable: without a document there
 * is no budget to prove spent.
 *
 * Lives in `src/ui/**` (which may read `src/approaches/**`) so the category
 * table stays single-copied; `src/model/**` only receives the plain verdict.
 */
export function graphBlockRecovery(
  store: Store,
  graphRunId: number,
  _projectMaxReplans?: number,
): GraphBlockRecovery {
  const run = graphRunIdStatusBlockedReason(store.db, graphRunId);
  const replanCount = graphRunStatusReplanCount(store.db, graphRunId)?.replan_count ?? 0;
  const revision = activeRevision(store.db, graphRunId);
  let maxReplans: number | null = null;
  if (revision) {
    const parsed = parseGraphDocument(revision.canonical_graph);
    if (parsed.ok) maxReplans = parsed.document.budgets.maxReplans;
  }
  const category = recoveryCategoryFor(run?.blocked_reason ?? null);
  const replan =
    category === 'explicit-resolution' ||
    category === 'config-then-resume' ||
    ((category === 'replan' || category === 'compile-new-revision') &&
      maxReplans !== null &&
      replanCount >= maxReplans);
  return { primary: replan ? 'replan' : 'resume', replanCount, maxReplans };
}

export function buildGraphInsideInput(
  deps: GraphInsideDeps,
  ticketId: number,
): GraphInsideInput | null {
  const run = latestGraphRunFor(deps.store, ticketId);
  if (!run) return null;

  const plannerRuns = plannerRunsForGraphRun(deps.store.db, run.id);
  const nodeRuns = nodeRunsForGraphRunDisplay(deps.store.db, run.id);

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
      `SELECT revision_number, status, fingerprint, id, planner_artifact_snapshot_id,
              length(canonical_graph) AS graph_bytes
         FROM approach_graph_revisions
        WHERE graph_run_id = ? AND status = 'active'
        ORDER BY revision_number DESC LIMIT 1`,
    )
    .get(run.id) as
    | {
        revision_number: number;
        status: string;
        fingerprint: string;
        id: number;
        planner_artifact_snapshot_id: string | null;
        graph_bytes: number;
      }
    | undefined;

  const topology = readTopology(deps.store, revision, deps.debug, () =>
    revision
      ? (deps.store.db
          .prepare('SELECT canonical_graph FROM approach_graph_revisions WHERE id = ?')
          .get(revision.id) as { canonical_graph: string } | undefined)?.canonical_graph
      : undefined,
  );

  const artifacts = deps.store.db
    .prepare(
      `SELECT artifact_id, media_type, byte_size, created_at,
              producer_node_run_id, producer_planner_run_id
         FROM approach_artifact_instances WHERE graph_run_id = ? ORDER BY id`,
    )
    .all(run.id) as {
    artifact_id: string;
    media_type: string;
    byte_size: number;
    created_at: string;
    producer_node_run_id: number | null;
    producer_planner_run_id: number | null;
  }[];
  const plannerNumberById = new Map(plannerRuns.map((p) => [p.id, p.planner_run_number]));

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

  const depsWarning = deps.depsWarningOf?.(run.id);
  // One grouped query per build (`/node-card/tokens`): the per-node spend the
  // details card states, never a query per node.
  const tokensByNodeRun = summarizeRecordedTokenUsageByNodeRun(deps.store, ticketId, run.id);
  return {
    enabled: true,
    graphRun: {
      id: run.id,
      runNumber: graphRunOrdinal(deps.store, ticketId, run.id),
      status: run.status,
      approachId: run.approach_id,
      stageAttempt: run.stage_attempt,
      createdAt: run.created_at,
      blockedReason: run.blocked_reason,
      ...(run.status === 'blocked'
        ? { recovery: graphBlockRecovery(deps.store, run.id, limits.maxReplans) }
        : {}),
      ...(depsWarning === undefined ? {} : { depsWarning }),
    },
    plannerRuns: plannerRuns.map((p) => ({
      plannerRunNumber: p.planner_run_number,
      plannerRunId: p.id,
      kind: p.kind,
      status: p.status,
      compileAttempt: p.compile_attempt,
      reason: p.reason,
      startedAt: p.started_at,
      submittedAt: p.submitted_at,
      endedAt: p.ended_at,
      graphSnapshotId: p.graph_snapshot_id,
    })),
    nodeRuns: nodeRuns.map((n) => {
      const tokens = tokensByNodeRun.get(n.id);
      return {
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
        ...(tokens ? { tokens } : {}),
      };
    }),
    overrides,
    deferrals: deferrals.map((d) => ({
      nodeId: d.node_id,
      reason: d.reason,
      waitSince: d.wait_since,
    })),
    execution: { maxParallel: limits.maxParallel, maxNodeRuns: limits.maxNodeRuns },
    ...(topology ? { topology } : {}),
    revision: revision
      ? {
          revisionNumber: revision.revision_number,
          status: revision.status,
          fingerprint: revision.fingerprint,
          plannerArtifactSnapshotId: revision.planner_artifact_snapshot_id,
        }
      : null,
    diagnostics: [],
    artifacts: artifacts.map((a) => {
      const plannerNumber =
        a.producer_planner_run_id === null
          ? undefined
          : plannerNumberById.get(a.producer_planner_run_id);
      return {
        artifactId: a.artifact_id,
        byteSize: a.byte_size,
        mediaType: a.media_type,
        createdAt: a.created_at,
        ...(a.producer_node_run_id !== null ? { producerNodeRunId: a.producer_node_run_id } : {}),
        ...(plannerNumber !== undefined ? { producerPlannerRunNumber: plannerNumber } : {}),
      };
    }),
    liveSessions,
    now: deps.now(),
  };
}
