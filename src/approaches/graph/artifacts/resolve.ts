/**
 * Causal artifact binding (Slice 4 Task 2).
 *
 * Every production records an immutable `ArtifactInstance` in the
 * `approach_artifact_instances` table, keyed by graph revision, producer
 * planner/node run, visit (the node run carries it) and fork lineage.
 * Inputs resolve to the NEWEST SUCCESSFUL instance in the activation's
 * causal lineage: the fork-lineage stack of the activation's claimed token
 * (a deeper lineage is a causally later loop visit), with planner-produced
 * artifacts as roots. A same-id instance outside the lineage is never
 * selected, and an ambiguous or missing binding BLOCKS — this module never
 * falls back to a global "latest". An instance from a superseded revision
 * is excluded by the revision filter, which is what prevents cross-revision
 * binding.
 *
 * Required-output validation snapshots the node's produced files through
 * the one-descriptor protocol (`snapshotFile`) and refuses an effective
 * `complete` when a required output is missing or unsafe — the pipeline
 * parks the node at `output-artifact-missing` / `artifact-unsafe` and emits
 * no edge. The reported `complete` stays immutable evidence; only the
 * EFFECTIVE outcome is gated.
 *
 * Host-agnostic and driver-agnostic: positional `?` only, no vscode.
 */

import { join } from 'node:path';
import type { GraphDb } from '../../../store/graph/transitions.js';
import { parseGraphDocument } from '../parse.js';
import { snapshotFile, type SnapshotMediaType } from './snapshot.js';

/** One immutable artifact production, as stored. */
export interface ArtifactInstanceRow {
  id: number;
  graph_run_id: number;
  revision_id: number | null;
  artifact_id: string;
  producer_planner_run_id: number | null;
  producer_node_run_id: number | null;
  fork_lineage: string | null;
  snapshot_path: string;
  sha256: string;
  media_type: string;
  byte_size: number;
  sensitivity: string | null;
  created_at: string;
}

export interface RecordArtifactInstanceInput {
  graphRunId: number;
  revisionId: number;
  artifactId: string;
  /** Non-null exactly when the planner produced this artifact. */
  producerPlannerRunId?: number | null;
  /** Non-null exactly when a node visit produced this artifact. */
  producerNodeRunId?: number | null;
  /** The producing activation's fork-lineage stack; NULL for planner roots. */
  forkLineage?: string | null;
  /** Absolute path of the content-addressed snapshot copy. */
  snapshotPath: string;
  sha256: string;
  mediaType: string;
  byteSize: number;
  /** V1 records no sensitivity classification; NULL is unknown, never invented. */
  sensitivity?: string | null;
  now: string;
}

/**
 * Record one immutable production. The table is insert-only rowid (the
 * v35 contract), so rowid order IS production order: "newest" reads resolve
 * by `id DESC`. No CAS: a production is written once, inside the same
 * transaction that accepts the effective outcome.
 */
export function recordArtifactInstance(
  db: GraphDb,
  input: RecordArtifactInstanceInput,
): number {
  const res = db
    .prepare(
      `INSERT INTO approach_artifact_instances
         (graph_run_id, revision_id, artifact_id, producer_planner_run_id,
          producer_node_run_id, fork_lineage, snapshot_path, sha256, media_type,
          byte_size, sensitivity, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.graphRunId,
      input.revisionId,
      input.artifactId,
      input.producerPlannerRunId ?? null,
      input.producerNodeRunId ?? null,
      input.forkLineage ?? null,
      input.snapshotPath,
      input.sha256,
      input.mediaType,
      input.byteSize,
      input.sensitivity ?? null,
      input.now,
    );
  return Number(res.lastInsertRowid);
}

export interface ResolveInputOpts {
  revisionId: number;
  nodeId: string;
  /** The activation's claimed tokens; their fork lineages define the
   *  activation's causal lineage (agent activations carry exactly one). */
  activationTokens: readonly { fork_lineage: string | null }[];
}

export type InputResolution =
  | { kind: 'bound'; instances: ArtifactInstanceRow[] }
  | { kind: 'missing'; artifactId: string }
  | { kind: 'ambiguous'; artifactId: string; candidates: number };

interface RevisionRow {
  canonical_graph: string;
}

/**
 * The candidate instances of one artifact in the activation's causal
 * lineage: same revision, and either planner-produced (roots) or produced
 * by a node run whose fork lineage is a PREFIX of the activation's lineage
 * (the lineage stack grows only on self-loops, so a deeper prefix is a
 * causally later loop visit; non-loop hops inherit the lineage unchanged,
 * which keeps every hop of a chain in the lineage). Newest first by rowid.
 */
function lineageCandidates(
  db: GraphDb,
  revisionId: number,
  artifactId: string,
  lineage: string | null,
): ArtifactInstanceRow[] {
  return db
    .prepare(
      `SELECT * FROM approach_artifact_instances
       WHERE revision_id = ? AND artifact_id = ?
         AND (producer_planner_run_id IS NOT NULL
              OR (producer_node_run_id IS NOT NULL AND ? IS NOT NULL
                  AND (fork_lineage = ? OR ? LIKE fork_lineage || ':%')))
       ORDER BY id DESC`,
    )
    .all(revisionId, artifactId, lineage, lineage, lineage) as ArtifactInstanceRow[];
}

/**
 * Resolve a node's declared inputs to the newest successful instance of
 * each in the activation's causal lineage, in declaration order. A missing
 * or ambiguous binding BLOCKS with the artifact named — never a global
 * "latest". A node with no declared inputs (or a document that cannot be
 * re-parsed) binds nothing.
 */
export function resolveInput(db: GraphDb, opts: ResolveInputOpts): InputResolution {
  const lineage = opts.activationTokens[0]?.fork_lineage ?? null;
  const revision = db
    .prepare('SELECT canonical_graph FROM approach_graph_revisions WHERE id = ?')
    .get(opts.revisionId) as RevisionRow | undefined;
  if (!revision) return { kind: 'bound', instances: [] };
  const parsed = parseGraphDocument(revision.canonical_graph);
  if (!parsed.ok) return { kind: 'bound', instances: [] };
  const node = parsed.document.nodes.find((n) => n.id === opts.nodeId);
  if (!node || node.kind !== 'agent' || node.inputs.length === 0) {
    return { kind: 'bound', instances: [] };
  }
  const instances: ArtifactInstanceRow[] = [];
  for (const inputId of node.inputs) {
    const candidates = lineageCandidates(db, opts.revisionId, inputId, lineage);
    const newest = candidates[0];
    if (!newest) return { kind: 'missing', artifactId: inputId };
    // Two candidates on the SAME lineage from different producer runs are
    // sibling productions — neither is causally after the other, so the
    // binding is ambiguous and BLOCKS instead of picking a rowid winner.
    const sibling = candidates.some(
      (c) => c.id !== newest.id && c.fork_lineage !== null && c.fork_lineage === newest.fork_lineage,
    );
    if (sibling) return { kind: 'ambiguous', artifactId: inputId, candidates: candidates.length };
    instances.push(newest);
  }
  return { kind: 'bound', instances };
}

/** A successfully snapshotted output, ready to record as an instance. */
export interface ValidatedOutput {
  artifactId: string;
  snapshotPath: string;
  sha256: string;
  mediaType: string;
  byteSize: number;
}

export type OutputValidationResult =
  | { ok: true; instances: ValidatedOutput[]; forkLineage: string | null }
  | {
      ok: false;
      code: 'output-artifact-missing' | 'artifact-unsafe';
      artifactId: string;
      reason: string;
    };

export interface ValidateOutputsOpts {
  revisionId: number;
  nodeId: string;
  nodeRunId: number;
  /** Absolute staging path per declared output artifact id. */
  outputPaths: Readonly<Record<string, string>>;
  /** The content-addressed snapshot root (the artifact root). */
  snapshotDir: string;
}

/**
 * Snapshot every declared output through the one-descriptor protocol and
 * return the validated instances; a REQUIRED output that is missing or
 * unsafe fails the whole validation with the node-run status it names. A
 * non-required output that is missing or unsafe produces no instance and
 * does not block. The producing activation's lineage (the node run's
 * claimed token's fork lineage) rides out for instance recording. A node
 * with no declared outputs validates trivially.
 */
export function validateRequiredOutputs(
  db: GraphDb,
  opts: ValidateOutputsOpts,
  debug?: (message: string) => void,
): OutputValidationResult {
  const result = validateOutputs(db, opts);
  // A node parked `output-artifact-missing` / `artifact-unsafe` is one of the
  // two node-level dead ends whose cause lives entirely outside the database:
  // the file the agent was supposed to write. Naming the artifact is the
  // difference between "the node parked" and "this artifact was not there".
  debug?.(
    result.ok
      ? `[graph] outputs: node ${opts.nodeId} run ${opts.nodeRunId} validated ${result.instances.length} artifact(s)`
      : `[graph] outputs: node ${opts.nodeId} run ${opts.nodeRunId} → ${result.code} for "${result.artifactId}" — ${result.reason}`,
  );
  return result;
}

function validateOutputs(
  db: GraphDb,
  opts: ValidateOutputsOpts,
): OutputValidationResult {
  if (Object.keys(opts.outputPaths).length === 0) {
    return { ok: true, instances: [], forkLineage: null };
  }
  const revision = db
    .prepare('SELECT canonical_graph FROM approach_graph_revisions WHERE id = ?')
    .get(opts.revisionId) as RevisionRow | undefined;
  if (!revision) return { ok: true, instances: [], forkLineage: null };
  const parsed = parseGraphDocument(revision.canonical_graph);
  if (!parsed.ok) return { ok: true, instances: [], forkLineage: null };
  const node = parsed.document.nodes.find((n) => n.id === opts.nodeId);
  if (!node || node.kind !== 'agent') return { ok: true, instances: [], forkLineage: null };
  const defs = new Map(parsed.document.artifacts.map((a) => [a.id, a]));

  const lineageRow = db
    .prepare(
      `SELECT fork_lineage FROM approach_graph_tokens
       WHERE claiming_node_run_id = ? AND status = 'claimed' ORDER BY id LIMIT 1`,
    )
    .get(opts.nodeRunId) as { fork_lineage: string | null } | undefined;
  const forkLineage = lineageRow?.fork_lineage ?? null;

  const instances: ValidatedOutput[] = [];
  for (const artifactId of node.outputs) {
    const def = defs.get(artifactId);
    if (!def) continue; // compile guarantees the def; a gap is not a constraint
    const stagingPath = opts.outputPaths[artifactId];
    if (stagingPath === undefined) {
      if (def.required) {
        return {
          ok: false,
          code: 'output-artifact-missing',
          artifactId,
          reason: `no staging path known for required output "${artifactId}"`,
        };
      }
      continue;
    }
    const snap = snapshotFile(
      { path: stagingPath, maxBytes: def.maxBytes, mediaType: def.mediaType },
      opts.snapshotDir,
    );
    if (!snap.ok) {
      if (!def.required) continue;
      return {
        ok: false,
        code: snap.code === 'missing' ? 'output-artifact-missing' : 'artifact-unsafe',
        artifactId,
        reason: snap.reason,
      };
    }
    instances.push({
      artifactId,
      snapshotPath: join(opts.snapshotDir, snap.sha256),
      sha256: snap.sha256,
      mediaType: def.mediaType,
      byteSize: snap.size,
    });
  }
  return { ok: true, instances, forkLineage };
}

// Re-export the media-type vocabulary the instance rows carry.
export type { SnapshotMediaType };
