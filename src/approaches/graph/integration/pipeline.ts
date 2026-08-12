/**
 * The completing-node pipeline (Slice 3 Task 8) — "Integration into canonical
 * worktrees".
 *
 * On a reported completion the CLI has already moved the node run
 * `running → completing`. This pipeline, driven by the coordinator's tick:
 *
 * 1. terminates the supervised process through the transport and requires
 *    positive termination evidence (`killed`/`dead`); anything else parks the
 *    node at `termination-unknown` — the lease stays held and the node is
 *    never automatically retried;
 * 2. validates the node's declared output artifacts (Slice 4 Task 2) BEFORE
 *    the effective outcome is accepted: every output is snapshotted through
 *    the one-descriptor protocol, and a missing or unsafe REQUIRED output
 *    leaves the effective outcome NULL — the node parks at
 *    `output-artifact-missing` / `artifact-unsafe`, the graph blocks, and NO
 *    edge is emitted. The agent-authored `complete` stays immutable reported
 *    evidence (`outcome`), never an accepted routing outcome;
 * 3. atomically claims the graph's single integrating slot (`completing →
 *    integrating` refused when ANY node of the graph is already integrating)
 *    — the durable, cross-window serialization: change sets integrate one at
 *    a time, in node-run order as the caller walks completing nodes by id;
 * 4. snapshots the actual diff per physical repository (`git diff HEAD` — the
 *    node's uncommitted/staged work in the canonical worktree) and compares
 *    it with the node's DECLARED writes BEFORE any integration; an
 *    out-of-claim mutation blocks with `resource-claim-violated` and V1 never
 *    silently widens a running node's claim;
 * 5. integrates valid change sets serially under that slot, committing each
 *    domain's validated paths with the integration marker. A git refusal to
 *    land the change set (failed add/commit) is `integration-conflict`:
 *    both trees are preserved for diagnosis and the graph blocks.
 *
 * Lease release (Slice 5 Task 2): a successful integration releases the node's
 * `held` leases in the SAME transaction that accepts the completion. Every
 * parked path — `termination-unknown`, `output-artifact-missing`,
 * `artifact-unsafe`, `claim-violated`, `integration-conflict` — keeps the
 * leases held (preserved behind the blocker; only the discard action or the
 * resumed integration releases them).
 *
 * The validated output instances are recorded in the SAME transaction that
 * accepts the effective `complete` (`integrating → completed`), so an
 * instance exists only for a production that actually completed — never for
 * a parked node.
 *
 * A node whose changes are entirely COMMITTED by the agent itself is the
 * known V1 scope of the canonical-worktree model: its commits are already in
 * the canonical history, and only the uncommitted remainder is validated.
 * Per-repository base digests and isolated workspaces — the design's shape
 * for that validation — arrive with parallel execution (Slice 5).
 *
 * The graph run blocks with `resource-claim-violated` / `integration-conflict`
 * (its `blocked_reason` carries the category); recovery/replan is the
 * graph-aware Resume of Slice-3 Task 9/10.
 */

import type { GraphDb } from '../../../store/graph/transitions.js';
import { casStatus, NODE_RUN_TRANSITIONS, GRAPH_RUN_TRANSITIONS } from '../../../store/graph/transitions.js';
import type { GitRunner } from '../../../integrations/git.js';
import type { AgentTransport, SupervisedAgentSession } from '../transport/supervisedCliTransport.js';
import { resolvePhysicalDomains, type DomainEntry } from './domains.js';
import { captureChangeSet, validateChangeSet, type ChangeSetEntry } from './changeSet.js';
import { completeActivation } from '../coordinator/completion.js';
import { releaseLeaseForNodeRun } from '../coordinator/leases.js';
import { recordArtifactInstance, validateRequiredOutputs } from '../artifacts/resolve.js';
import { parseGraphDocument } from '../parse.js';
import { join } from 'node:path';

export const INTEGRATION_COMMIT_PREFIX = 'karst: integrate graph';

export interface CompletionPipelineDeps {
  db: GraphDb;
  /** BEGIN IMMEDIATE-wrapped, all-or-nothing; a throw rolls back. */
  transaction: <T>(fn: () => T) => T;
  now: () => string;
  debug?: (message: string) => void;
  git: GitRunner;
  /** `git rev-parse --git-common-dir` for the domain key. */
  gitCommonDirOf: (cwd: string) => string | null;
  transport: AgentTransport;
  /** The transport's session for a node run; undefined after a reload. */
  getSession: (nodeRunId: number) => SupervisedAgentSession | undefined;
  /** The ticket's manifest repository entries (name + worktree path). */
  domainsFor: () => DomainEntry[];
  /** The node's DECLARED writes, per physical domain key. */
  declaredWritesOf: (nodeRunId: number) => { domainKey: string; paths: string[] }[];
  /** The graph run's artifact root (global storage; staging + snapshots). */
  artifactRoot: () => string;
}

export type CompletionPipelineResult =
  | { kind: 'no-op' }
  | { kind: 'deferred' }
  | { kind: 'termination-unknown' }
  | { kind: 'output-artifact-missing'; artifactId: string; reason: string }
  | { kind: 'artifact-unsafe'; artifactId: string; reason: string }
  | { kind: 'claim-violated'; violations: string[] }
  | { kind: 'integration-conflict'; reason: string }
  | { kind: 'integrated'; committed: boolean };

interface NodeRunRow {
  id: number;
  graph_run_id: number;
  revision_id: number;
  node_id: string;
  status: string;
}

interface GraphRunRow {
  id: number;
  status: string;
}

function parkNode(
  deps: CompletionPipelineDeps,
  nodeRunId: number,
  from: 'completing' | 'integrating',
  status:
    | 'termination-unknown'
    | 'blocked'
    | 'output-artifact-missing'
    | 'artifact-unsafe',
  fields: { outcome?: string; failureCategory?: string; reason?: string },
): void {
  deps.transaction(() => {
    if (!casStatus(deps.db, 'approach_node_runs', NODE_RUN_TRANSITIONS, nodeRunId, from, status)) {
      return;
    }
    if (status !== 'termination-unknown') {
      deps.db
        .prepare(
          `UPDATE approach_node_runs
           SET outcome = ?, failure_category = ?, reason = ?
           WHERE id = ?`,
        )
        .run(fields.outcome ?? null, fields.failureCategory ?? null, fields.reason ?? null, nodeRunId);
    }
  });
}

function blockGraphRun(
  deps: CompletionPipelineDeps,
  graphRunId: number,
  reason: string,
): void {
  deps.transaction(() => {
    if (
      casStatus(
        deps.db,
        'approach_graph_runs',
        GRAPH_RUN_TRANSITIONS,
        graphRunId,
        'running',
        'blocked',
      )
    ) {
      deps.db
        .prepare('UPDATE approach_graph_runs SET blocked_reason = ?, updated_at = ? WHERE id = ?')
        .run(reason, deps.now(), graphRunId);
    }
  });
}

/** Bounded single-line reason from git stderr (the rest is for the log). */
function boundedGitReason(stderr: string): string {
  const line = stderr.split('\n').find((l) => l.trim() !== '');
  const collapsed = (line ?? 'git refused').trim().slice(0, 200);
  return collapsed;
}

/**
 * The node's DECLARED output staging paths, keyed by artifact id: the
 * canonical document's artifact defs resolve against the artifact root. A
 * document that cannot be re-parsed declares nothing (compile guaranteed it
 * once; a gap is not a constraint).
 */
function declaredOutputPaths(
  db: GraphDb,
  revisionId: number,
  nodeId: string,
  artifactRoot: string,
): Record<string, string> {
  const revision = db
    .prepare('SELECT canonical_graph FROM approach_graph_revisions WHERE id = ?')
    .get(revisionId) as { canonical_graph: string } | undefined;
  if (!revision) return {};
  const parsed = parseGraphDocument(revision.canonical_graph);
  if (!parsed.ok) return {};
  const node = parsed.document.nodes.find((n) => n.id === nodeId);
  if (!node || node.kind !== 'agent') return {};
  const defs = new Map(parsed.document.artifacts.map((a) => [a.id, a]));
  const paths: Record<string, string> = {};
  for (const artifactId of node.outputs) {
    const def = defs.get(artifactId);
    if (def) paths[artifactId] = join(artifactRoot, def.path);
  }
  return paths;
}

/**
 * The one conditional UPDATE that claims the graph's integrating slot: the
 * node moves `completing → integrating` only when no OTHER node of the graph
 * is integrating. A single statement is atomic in SQLite — the durable,
 * cross-window serialization the design's physical-repository lock requires.
 */
function claimIntegratingSlot(
  deps: CompletionPipelineDeps,
  graphRunId: number,
  nodeRunId: number,
): boolean {
  const res = deps.db
    .prepare(
      `UPDATE approach_node_runs
       SET status = 'integrating'
       WHERE id = ? AND status = 'completing'
         AND NOT EXISTS (
           SELECT 1 FROM approach_node_runs
           WHERE graph_run_id = ? AND id != ? AND status = 'integrating'
         )`,
    )
    .run(nodeRunId, graphRunId, nodeRunId);
  return res.changes === 1;
}

async function terminationProven(
  deps: CompletionPipelineDeps,
  nodeRunId: number,
): Promise<boolean> {
  const session = deps.getSession(nodeRunId);
  if (!session) {
    deps.debug?.(`[graph] completing node ${nodeRunId}: no session in the registry — cannot prove termination`);
    return false;
  }
  const proof = await deps.transport.terminate(session);
  const proven =
    (proof.kind === 'attributable' && proof.kill === 'killed') || proof.kind === 'dead';
  if (!proven) {
    deps.debug?.(
      `[graph] completing node ${nodeRunId}: termination not proven (${proof.kind}${proof.kind === 'attributable' ? `:${proof.kill}` : ''})`,
    );
  }
  return proven;
}

/**
 * Run the completing pipeline for one node. Returns a closed result; every
 * state change is CAS-guarded so a second window's racing pipeline reads
 * `no-op`/`deferred` instead of corrupting state.
 */
export async function runCompletionPipeline(
  deps: CompletionPipelineDeps,
  input: { graphRunId: number; nodeRunId: number },
): Promise<CompletionPipelineResult> {
  const run = deps.db
    .prepare('SELECT id, status FROM approach_graph_runs WHERE id = ?')
    .get(input.graphRunId) as GraphRunRow | undefined;
  if (!run || run.status !== 'running') return { kind: 'no-op' };
  const node = deps.db
    .prepare('SELECT id, graph_run_id, revision_id, node_id, status FROM approach_node_runs WHERE id = ?')
    .get(input.nodeRunId) as NodeRunRow | undefined;
  if (!node || node.status !== 'completing') return { kind: 'no-op' };

  deps.debug?.(`[graph] completing node ${input.nodeRunId} — terminating and verifying`);
  if (!(await terminationProven(deps, input.nodeRunId))) {
    parkNode(deps, input.nodeRunId, 'completing', 'termination-unknown', {});
    return { kind: 'termination-unknown' };
  }

  // Slice 4 Task 2: required outputs are validated BEFORE the effective
  // outcome is accepted. A missing or unsafe REQUIRED output parks the node
  // (effective outcome null, no edge) and blocks the graph — the reported
  // `complete` stays evidence, never a routing outcome.
  const artifactRoot = deps.artifactRoot();
  const validation = validateRequiredOutputs(deps.db, {
    revisionId: node.revision_id,
    nodeId: node.node_id,
    nodeRunId: input.nodeRunId,
    outputPaths: declaredOutputPaths(deps.db, node.revision_id, node.node_id, artifactRoot),
    snapshotDir: artifactRoot,
  });
  if (!validation.ok) {
    const reason = `${validation.code}: artifact "${validation.artifactId}" ${validation.code === 'output-artifact-missing' ? 'produced nothing' : `failed validation: ${validation.reason}`}`;
    deps.debug?.(`[graph] completing node ${input.nodeRunId}: ${reason}`);
    parkNode(deps, input.nodeRunId, 'completing', validation.code, {
      outcome: 'complete',
      failureCategory: validation.code,
      reason,
    });
    blockGraphRun(deps, input.graphRunId, reason);
    return { kind: validation.code, artifactId: validation.artifactId, reason };
  }

  if (!claimIntegratingSlot(deps, input.graphRunId, input.nodeRunId)) {
    const now = deps.db
      .prepare('SELECT status FROM approach_node_runs WHERE id = ?')
      .get(input.nodeRunId) as { status: string };
    if (now.status === 'completing') {
      return { kind: 'deferred' }; // another node of the graph is integrating
    }
    return { kind: 'no-op' }; // already moved by a racing window
  }

  // Snapshot + validate. Domains are sorted by key; change sets are captured
  // per domain and validated against that domain's declared writes.
  const domains = resolvePhysicalDomains(deps.domainsFor(), deps.gitCommonDirOf);
  const declared = new Map(deps.declaredWritesOf(input.nodeRunId).map((d) => [d.domainKey, d.paths]));
  const captured = new Map<string, ChangeSetEntry[]>();
  const violations: string[] = [];
  for (const domain of domains) {
    let entries: ChangeSetEntry[];
    try {
      entries = await captureChangeSet(deps.git, {
        cwd: domain.canonicalWorktree,
        baseRef: 'HEAD',
      });
    } catch (err) {
      deps.debug?.(
        `[graph] completing node ${input.nodeRunId}: change-set capture failed for ${domain.key}: ${String(err)}`,
      );
      blockGraphRun(
        deps,
        input.graphRunId,
        `integration-conflict: change-set capture failed for ${domain.repoNames.join('/')}`,
      );
      return { kind: 'integration-conflict', reason: 'change-set capture failed' };
    }
    captured.set(domain.key, entries);
    const validation = validateChangeSet(declared.get(domain.key) ?? [], entries);
    if (!validation.ok) violations.push(...validation.violations);
  }
  if (violations.length > 0) {
    const reason = `resource-claim-violated: ${violations.slice(0, 5).join(', ')}`;
    deps.debug?.(`[graph] completing node ${input.nodeRunId}: ${reason}`);
    parkNode(deps, input.nodeRunId, 'integrating', 'blocked', {
      outcome: 'failed',
      failureCategory: 'resource-claim-violated',
      reason,
    });
    blockGraphRun(deps, input.graphRunId, reason);
    return { kind: 'claim-violated', violations };
  }

  // Integrate serially per domain in sorted-key order (the slot already
  // guarantees at most one integrator in the whole graph).
  let committed = false;
  for (const domain of domains) {
    const entries = captured.get(domain.key) ?? [];
    if (entries.length === 0) continue;
    const paths = entries.map((e) => e.path);
    const add = await deps.git(['add', '--all', '--', ...paths], domain.canonicalWorktree);
    if (add.exitCode !== 0) {
      const reason = `integration-conflict: git add refused in ${domain.repoNames.join('/')} (${boundedGitReason(add.stderr)})`;
      parkNode(deps, input.nodeRunId, 'integrating', 'blocked', {
        outcome: 'failed',
        failureCategory: 'integration-conflict',
        reason,
      });
      blockGraphRun(deps, input.graphRunId, reason);
      return { kind: 'integration-conflict', reason: add.stderr };
    }
    const commit = await deps.git(
      ['commit', '-m', `${INTEGRATION_COMMIT_PREFIX} ${input.graphRunId} node ${input.nodeRunId}`],
      domain.canonicalWorktree,
    );
    if (commit.exitCode !== 0) {
      const reason = `integration-conflict: git commit refused in ${domain.repoNames.join('/')} (${boundedGitReason(commit.stderr)})`;
      parkNode(deps, input.nodeRunId, 'integrating', 'blocked', {
        outcome: 'failed',
        failureCategory: 'integration-conflict',
        reason,
      });
      blockGraphRun(deps, input.graphRunId, reason);
      return { kind: 'integration-conflict', reason: commit.stderr };
    }
    committed = true;
  }

  deps.transaction(() => {
    if (!casStatus(deps.db, 'approach_node_runs', NODE_RUN_TRANSITIONS, input.nodeRunId, 'integrating', 'completed')) {
      return;
    }
    deps.db
      .prepare(
        `UPDATE approach_node_runs
         SET outcome = 'complete', effective_outcome = 'complete',
             change_set_id = ?, ended_at = ?
         WHERE id = ?`,
      )
      .run(`cs:${input.graphRunId}:${input.nodeRunId}`, deps.now(), input.nodeRunId);
    // Slice 4 Task 2: record the validated output instances in the SAME
    // transaction that accepts the effective complete — an instance exists
    // only for a production that actually completed. The lineage is the
    // producing activation's, read once by the validation.
    for (const out of validation.instances) {
      recordArtifactInstance(deps.db, {
        graphRunId: input.graphRunId,
        revisionId: node.revision_id,
        artifactId: out.artifactId,
        producerPlannerRunId: null,
        producerNodeRunId: input.nodeRunId,
        forkLineage: validation.forkLineage,
        snapshotPath: out.snapshotPath,
        sha256: out.sha256,
        mediaType: out.mediaType,
        byteSize: out.byteSize,
        now: deps.now(),
      });
    }
    // Consume the node's claimed tokens and insert its outcome successors in
    // the SAME transaction (the inner transaction wrapper is a pass-through:
    // this call already runs inside the pipeline's transaction). An END edge
    // lands the END token that quiescence waits for.
    completeActivation(
      { ...deps, transaction: <T>(fn: () => T): T => fn() },
      { nodeRunId: input.nodeRunId, effectiveOutcome: 'complete' },
    );
    // Slice 5 Task 2: the change set INTEGRATED — termination is proven and
    // the work is landed, so the node's `held` leases release here, in the
    // same transaction that accepts the completion. An `ambiguous-process`
    // lease is left strictly alone (only the discard action may move one).
    releaseLeaseForNodeRun(deps.db, input.nodeRunId);
  });
  deps.debug?.(
    `[graph] node ${input.nodeRunId} integrated${committed ? '' : ' (no changes)'} — completed`,
  );
  return { kind: 'integrated', committed };
}
