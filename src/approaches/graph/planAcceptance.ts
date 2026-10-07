import { join } from 'node:path';
import type { GraphDb } from '../../store/graph/transitions.js';
import {
  GraphStoreError,
  GRAPH_RUN_TRANSITIONS,
  casStatus,
} from '../../store/graph/transitions.js';
import {
  markGraphRunBlocked,
} from '../../store/graph/graphRuns.js';
import { graphRunById } from '../../store/graph/graphRuns.js';
import {
  plannerRunIdsForGraphRun,
  setPlannerRunReason,
  setPlannerRunReasonEndedAt,
  submittedPlannerRunForGraphRun,
  submittedReplanPlannerForTarget,
  transitionPlannerRun,
} from '../../store/graph/plannerRuns.js';
import { activeRevision, createRevision, drainingRevision, nextRevisionNumber } from '../../store/graph/revisions.js';
import { insertEntryTokens } from '../../store/graph/tokens.js';
import type { GraphDocument } from './parse.js';
import { parseGraphDocument } from './parse.js';
import {
  compileGraphDocument,
  type CompileContext,
  type CompileResult,
} from './compile.js';
import { submitReplanDocument } from './coordinator/replan.js';
import { cancelNodeRuns } from './coordinator/abandonedNodes.js';
import { ACTIVE_NODE_STATUSES } from './coordinator/completion.js';
import {
  MAX_COMPILE_ATTEMPTS,
  nextCompileAttempt,
  recordCompileAttempt,
} from './coordinator/repair.js';
import { finishPlanning } from './coordinator/plannerRun.js';
import { recordArtifactInstance } from './artifacts/resolve.js';
import { snapshotFile } from './artifacts/snapshot.js';

export interface GraphDriverDepsForPlanAcceptance {
  db: GraphDb;
  transaction: <T>(fn: () => T) => T;
  now: () => string;
  debug?: (message: string) => void;
  graphConfigOf: (approachId: string) => { limits: { confirmGeneratedGraph?: boolean } } | undefined;
  manifestResolvedFor?: (
    graphRunId: number,
  ) => { resolved: true } | { resolved: false; reason: string };
  compileContextOf: (graphRunId: number, document?: GraphDocument) => CompileContext;
  readBytes: (graphRunId: number, relativePath: string) => Uint8Array | undefined;
  writeSnapshot: (graphRunId: number, relativePath: string, bytes: Uint8Array) => void;
  artifactRootOf: (graphRunId: number) => string;
  physicalDomainsOf?: (graphRunId: number, document: GraphDocument, nodeId: string) => string[];
}

export type AcceptPlanResult =
  | { kind: 'accepted'; revisionId: number; revisionNumber: number }
  | { kind: 'no-op' }
  | { kind: 'undecidable'; reason: string }
  | {
      kind: 'repair-requested';
      plannerRunId: number;
      attempt: number;
      diagnostics: string[];
    }
  | { kind: 'rejected'; diagnostics: string[] };

export type AcceptReplanResult =
  | { kind: 'accepted'; revisionId: number; revisionNumber: number }
  | { kind: 'no-op' }
  | { kind: 'undecidable'; reason: string }
  | {
      kind: 'repair-requested';
      plannerRunId: number;
      attempt: number;
      diagnostics: string[];
    }
  | { kind: 'rejected'; reason: string };

export function acceptSubmittedPlan(
  deps: GraphDriverDepsForPlanAcceptance,
  graphRunId: number,
): AcceptPlanResult {
  const run = graphRunById(deps.db, graphRunId);
  if (!run || run.status !== 'planning') {
    deps.debug?.(
      `[graph] run ${graphRunId}: bootstrap submission not accepted — ${
        run ? `run is ${run.status}, not planning` : 'run not found'
      }`,
    );
    return { kind: 'no-op' };
  }

  const existing = activeRevision(deps.db, graphRunId);
  if (existing) {
    const confirm = configConfirmOf(deps, run.approach_id);
    deps.transaction(() => {
      finishPlanning(deps.db, graphRunId, confirm);
    });
    deps.debug?.(
      `[graph] run ${graphRunId}: bootstrap plan already accepted — repaired run status to ${confirm ? 'awaiting-confirmation' : 'running'}, revision ${existing.id}`,
    );
    return { kind: 'accepted', revisionId: existing.id, revisionNumber: existing.revision_number };
  }

  const planner = submittedPlannerRunForGraphRun(deps.db, graphRunId, 'bootstrap');
  if (!planner || !planner.graph_snapshot_id) {
    deps.debug?.(
      `[graph] run ${graphRunId}: nothing to accept — ${
        planner ? `planner ${planner.id} submitted no graph snapshot` : 'no submitted bootstrap planner'
      }`,
    );
    return { kind: 'no-op' };
  }

  const resolution = deps.manifestResolvedFor?.(graphRunId) ?? { resolved: true as const };
  if (!resolution.resolved) {
    deps.debug?.(
      `[graph] run ${graphRunId}: bootstrap plan not judged — ${resolution.reason}; left planning for the next tick`,
    );
    return { kind: 'undecidable', reason: resolution.reason };
  }

  const snapshotPath = join('snapshots', `${planner.graph_snapshot_id}.json`);
  const bytes = deps.readBytes(graphRunId, snapshotPath);
  if (bytes === undefined) {
    return rejectPlan(deps, graphRunId, planner.id, [
      'planner-no-output: submitted snapshot is unreadable',
    ]);
  }
  const parsed = parseGraphDocument(new TextDecoder().decode(bytes));
  if (!parsed.ok) {
    return rejectPlan(
      deps,
      graphRunId,
      planner.id,
      parsed.diagnostics.map((d) => `${d.code}: ${d.where}: ${d.message}`),
    );
  }
  const compiled = compileGraphDocument(
    parsed.document,
    deps.compileContextOf(graphRunId, parsed.document),
    deps.debug,
  );
  if (!compiled.ok) {
    return rejectPlan(
      deps,
      graphRunId,
      planner.id,
      compiled.diagnostics.map((d) => `${d.code}: ${d.where}: ${d.message}`),
    );
  }
  const { compiled: c } = compiled;
  const confirm = configConfirmOf(deps, run.approach_id);
  const outcome = deps.transaction(() => {
    const existing = activeRevision(deps.db, graphRunId);
    if (existing) {
      finishPlanning(deps.db, graphRunId, confirm);
      return { id: existing.id, revisionNumber: existing.revision_number, already: true } as const;
    }
    // A bootstrap relaunch can recover a run whose earlier revision is still
    // `draining` (the replan-park leaves exactly one). This recovery abandons
    // that drain, so supersede it AND cancel its still-active node runs: a
    // lingering second `draining` revision would make the drain selectors
    // disagree, and a surviving `blocked` replan requester (or its held lease)
    // would block the recovered revision's END quiescence run-wide forever.
    const placeholders = ACTIVE_NODE_STATUSES.map(() => '?').join(', ');
    const abandoned = deps.db
      .prepare(
        `SELECT n.id, n.status, n.node_kind, n.revision_id, n.node_id
         FROM approach_node_runs n
         JOIN approach_graph_revisions r ON r.id = n.revision_id
         WHERE n.graph_run_id = ? AND r.status = 'draining' AND n.status IN (${placeholders})`,
      )
      .all(graphRunId, ...ACTIVE_NODE_STATUSES) as Array<{
      id: number;
      status: string;
      node_kind: string;
      revision_id: number;
      node_id: string;
    }>;
    deps.db
      .prepare(
        `UPDATE approach_graph_revisions SET status = 'superseded', superseded_at = ?
         WHERE graph_run_id = ? AND status = 'draining'`,
      )
      .run(deps.now(), graphRunId);
    cancelNodeRuns(
      { db: deps.db, now: deps.now },
      graphRunId,
      abandoned.map((n) => ({
        id: n.id,
        status: n.status,
        nodeKind: n.node_kind,
        revisionId: n.revision_id,
        nodeId: n.node_id,
      })),
    );
    // Monotonic: normally 1 (the first plan), but it continues past an
    // abandoned prior revision so UNIQUE (graph_run_id, revision_number) holds.
    const revisionNumber = nextRevisionNumber(deps.db, graphRunId);
    const id = createRevision(deps.db, {
      graphRunId,
      revisionNumber,
      canonicalGraph: c.canonicalJson,
      fingerprint: c.fingerprint,
      status: 'active',
      now: deps.now(),
    });
    deps.db
      .prepare(
        `UPDATE approach_graph_revisions
         SET planner_graph_snapshot_id = ?, planner_artifact_snapshot_id = ?
         WHERE id = ?`,
      )
      .run(c.fingerprint, planner.graph_snapshot_id ?? null, id);
    recordPlannerArtifacts(deps, graphRunId, id, planner.id, c.document);
    insertEntryTokens(
      deps.db,
      id,
      c.document.entries.map((nodeId) => ({
        edgeId: `entry-${nodeId}`,
        destinationNodeId: nodeId,
        destinationEnd: false,
      })),
      deps.now(),
    );
    if (!finishPlanning(deps.db, graphRunId, confirm)) {
      throw new GraphStoreError(
        `acceptSubmittedPlan: run ${graphRunId} left planning before its transition`,
      );
    }
    return { id, revisionNumber, already: false } as const;
  });
  if (outcome.already) {
    deps.debug?.(
      `[graph] run ${graphRunId}: bootstrap plan already accepted — repaired run status to ${confirm ? 'awaiting-confirmation' : 'running'}, revision ${outcome.id}`,
    );
  } else {
    deps.debug?.(
      `[graph] run ${graphRunId}: bootstrap plan accepted — revision ${outcome.id} (#${outcome.revisionNumber}) → ${confirm ? 'awaiting-confirmation' : 'running'}`,
    );
  }
  return { kind: 'accepted', revisionId: outcome.id, revisionNumber: outcome.revisionNumber };
}

export function acceptSubmittedReplan(
  deps: GraphDriverDepsForPlanAcceptance,
  graphRunId: number,
): AcceptReplanResult {
  const run = graphRunById(deps.db, graphRunId);
  if (!run || run.status !== 'draining') return { kind: 'no-op' };
  // Scope the accept to the CURRENT drain: its planner is bound to the
  // draining revision's successor. A completed replan's planner row stays
  // `submitted` forever, so an unscoped lookup (`ORDER BY id LIMIT 1`) would
  // resolve to a PRIOR drain's planner and land its stale document as the next
  // revision. A Stop drain has no draining revision and nothing to accept.
  const draining = drainingRevision(deps.db, graphRunId);
  if (!draining) return { kind: 'no-op' };
  const planner = submittedReplanPlannerForTarget(
    deps.db,
    graphRunId,
    draining.revision_number + 1,
  );
  if (!planner || !planner.graph_snapshot_id) {
    deps.debug?.(
      `[graph] run ${graphRunId}: nothing to accept — ${
        planner ? `planner ${planner.id} submitted no graph snapshot` : 'no submitted bootstrap planner'
      }`,
    );
    return { kind: 'no-op' };
  }

  const resolution = deps.manifestResolvedFor?.(graphRunId) ?? { resolved: true as const };
  if (!resolution.resolved) {
    deps.debug?.(
      `[graph] run ${graphRunId}: replan not judged — ${resolution.reason}; left draining for the next tick`,
    );
    return { kind: 'undecidable', reason: resolution.reason };
  }

  const bytes = deps.readBytes(graphRunId, join('snapshots', `${planner.graph_snapshot_id}.json`));
  if (bytes === undefined) {
    return rejectReplan(deps, graphRunId, planner.id, [
      'planner-no-output: submitted replan snapshot is unreadable',
    ]);
  }
  const parsed = parseGraphDocument(new TextDecoder().decode(bytes));
  if (!parsed.ok) {
    return rejectReplan(
      deps,
      graphRunId,
      planner.id,
      parsed.diagnostics.map((d) => `${d.code}: ${d.where}: ${d.message}`),
    );
  }
  const compileDocument = (document: GraphDocument): CompileResult =>
    compileGraphDocument(document, deps.compileContextOf(graphRunId, document), deps.debug);
  const physicalDomainsOf = deps.physicalDomainsOf
    ? (nodeId: string): string[] => deps.physicalDomainsOf!(graphRunId, parsed.document, nodeId)
    : (): string[] => [];
  const result = submitReplanDocument(
    {
      db: deps.db,
      transaction: deps.transaction,
      now: deps.now,
      debug: deps.debug,
      compileDocument,
      physicalDomainsOf,
    },
    { plannerRunId: planner.id, document: parsed.document, rationale: 'replan accepted by recovery' },
  );
  if (!result.ok) {
    if (result.reason !== 'invalid-document') return { kind: 'rejected', reason: result.reason };
    const recompiled = compileDocument(parsed.document);
    return rejectReplan(
      deps,
      graphRunId,
      planner.id,
      recompiled.ok
        ? ['invalid-document: the replan was rejected by the compiler']
        : recompiled.diagnostics.map((d) => `${d.code}: ${d.where}: ${d.message}`),
    );
  }
  deps.debug?.(
    `[graph] run ${graphRunId}: replan accepted — revision ${result.revisionId} (#${result.revisionNumber}), ${result.deferredNodeIds.length} deferred node(s)`,
  );
  return { kind: 'accepted', revisionId: result.revisionId, revisionNumber: result.revisionNumber };
}

export function diagnosticsPathFor(plannerRunId: number): string {
  return `diagnostics/planner-${plannerRunId}.json`;
}

export function readPlannerDiagnostics(
  deps: Pick<GraphDriverDepsForPlanAcceptance, 'readBytes'>,
  graphRunId: number,
  plannerRunId: number,
): string[] {
  const bytes = deps.readBytes(graphRunId, diagnosticsPathFor(plannerRunId));
  if (bytes === undefined) return [];
  try {
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    return Array.isArray(parsed) ? parsed.map((d) => String(d)) : [];
  } catch {
    return [];
  }
}

export function compileDiagnosticsSection(diagnostics: readonly string[]): string | undefined {
  if (diagnostics.length === 0) return undefined;
  return [
    'The compiler REJECTED the previous `graph.json` with these diagnostics.',
    'Each line is `code: where: message` from the karst graph compiler — fix every one of them; do not resubmit the same document.',
    '```',
    ...diagnostics.slice(0, 50).map((d) => String(d).slice(0, 500)),
    '```',
  ].join('\n');
}

export function latestPlannerDiagnostics(
  deps: Pick<GraphDriverDepsForPlanAcceptance, 'readBytes' | 'db'>,
  graphRunId: number,
): string[] {
  for (const plannerRunId of plannerRunIdsForGraphRun(deps.db, graphRunId)) {
    const diagnostics = readPlannerDiagnostics(deps, graphRunId, plannerRunId);
    if (diagnostics.length > 0) return diagnostics;
  }
  return [];
}

function configConfirmOf(
  deps: Pick<GraphDriverDepsForPlanAcceptance, 'graphConfigOf'>,
  approachId: string,
): boolean {
  return deps.graphConfigOf(approachId)?.limits.confirmGeneratedGraph ?? true;
}

function recordPlannerArtifacts(
  deps: GraphDriverDepsForPlanAcceptance,
  graphRunId: number,
  revisionId: number,
  plannerRunId: number,
  document: GraphDocument,
): void {
  const root = deps.artifactRootOf(graphRunId);
  if (!root) return;
  for (const artifact of document.artifacts) {
    if (artifact.producer !== '$planner') continue;
    const snap = snapshotFile(
      { path: join(root, artifact.path), maxBytes: artifact.maxBytes, mediaType: artifact.mediaType },
      root,
    );
    if (!snap.ok) {
      deps.debug?.(
        `[graph] run ${graphRunId}: planner artifact "${artifact.id}" not recorded (${snap.code}: ${snap.reason})`,
      );
      continue;
    }
    recordArtifactInstance(deps.db, {
      graphRunId,
      revisionId,
      artifactId: artifact.id,
      producerPlannerRunId: plannerRunId,
      producerNodeRunId: null,
      forkLineage: null,
      snapshotPath: join(root, snap.sha256),
      sha256: snap.sha256,
      mediaType: artifact.mediaType,
      byteSize: snap.size,
      now: deps.now(),
    });
  }
}

type RepairRunStatus = 'planning' | 'draining';

function writeDiagnosticsFile(
  deps: Pick<GraphDriverDepsForPlanAcceptance, 'writeSnapshot' | 'debug'>,
  graphRunId: number,
  plannerRunId: number,
  diagnostics: string[],
): void {
  try {
    deps.writeSnapshot(
      graphRunId,
      diagnosticsPathFor(plannerRunId),
      new TextEncoder().encode(JSON.stringify(diagnostics, null, 2)),
    );
  } catch (err) {
    deps.debug?.(`[graph] run ${graphRunId}: diagnostics write failed (${String(err)})`);
  }
}

function rejectPlan(
  deps: GraphDriverDepsForPlanAcceptance,
  graphRunId: number,
  plannerRunId: number,
  diagnostics: string[],
  runStatus: RepairRunStatus = 'planning',
): AcceptPlanResult {
  const decision = nextCompileAttempt(deps.db, plannerRunId);
  if (decision.exhausted) {
    return blockInvalidPlan(deps, graphRunId, plannerRunId, diagnostics, decision.attempt, runStatus);
  }
  const reprompted = deps.transaction(() => {
    if (!transitionPlannerRun(deps.db, plannerRunId, 'submitted', 'blocked')) return false;
    recordCompileAttempt(deps, plannerRunId, decision.attempt);
    setPlannerRunReason(
      deps.db,
      plannerRunId,
      `graph-plan-invalid: ${(diagnostics[0] ?? 'invalid document').slice(0, 2000)}`,
    );
    return true;
  });
  if (!reprompted) {
    deps.debug?.(
      `[graph] run ${graphRunId}: compile repair for planner ${plannerRunId} lost the submitted→blocked CAS — another window owns it`,
    );
    return { kind: 'undecidable', reason: 'planner run already moved' };
  }
  writeDiagnosticsFile(deps, graphRunId, plannerRunId, diagnostics);
  deps.debug?.(
    `[graph] run ${graphRunId}: ${runStatus === 'draining' ? 'replan' : 'bootstrap'} plan rejected on compile attempt ${decision.attempt}/${MAX_COMPILE_ATTEMPTS} — re-prompting planner ${plannerRunId} with ${diagnostics.length} diagnostic(s)`,
  );
  return { kind: 'repair-requested', plannerRunId, attempt: decision.attempt, diagnostics };
}

function blockInvalidPlan(
  deps: GraphDriverDepsForPlanAcceptance,
  graphRunId: number,
  plannerRunId: number,
  diagnostics: string[],
  attempt?: number,
  runStatus: RepairRunStatus = 'planning',
): AcceptPlanResult {
  const reason = `graph-plan-invalid: ${diagnostics[0] ?? 'planner produced an invalid document'}`;
  const blocked = deps.transaction(() => {
    if (attempt !== undefined) recordCompileAttempt(deps, plannerRunId, attempt);
    setPlannerRunReasonEndedAt(deps.db, plannerRunId, reason.slice(0, 2000), deps.now());
    if (
      !casStatus(deps.db, 'approach_graph_runs', GRAPH_RUN_TRANSITIONS, graphRunId, runStatus, 'blocked')
    ) {
      return false;
    }
    markGraphRunBlocked(deps.db, graphRunId, reason, deps.now());
    return true;
  });
  if (blocked) {
    writeDiagnosticsFile(deps, graphRunId, plannerRunId, diagnostics);
    deps.debug?.(`[graph] run ${graphRunId}: bootstrap plan rejected — ${reason}`);
  }
  return { kind: 'rejected', diagnostics };
}

function rejectReplan(
  deps: GraphDriverDepsForPlanAcceptance,
  graphRunId: number,
  plannerRunId: number,
  diagnostics: string[],
): AcceptReplanResult {
  const result = rejectPlan(deps, graphRunId, plannerRunId, diagnostics, 'draining');
  switch (result.kind) {
    case 'repair-requested':
      return {
        kind: 'repair-requested',
        plannerRunId: result.plannerRunId,
        attempt: result.attempt,
        diagnostics: result.diagnostics,
      };
    case 'undecidable':
      return { kind: 'undecidable', reason: result.reason };
    default:
      return { kind: 'rejected', reason: diagnostics[0] ?? 'invalid document' };
  }
}
