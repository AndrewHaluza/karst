/**
 * The completing-node pipeline (Slice 3 Task 8, Slice 5 Task 5).
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
 * 3. SERIALIZES PER PHYSICAL DOMAIN (Slice 5 Task 5): before the node may
 *    integrate a change set for a domain it must HOLD (or ACQUIRE) that
 *    domain's durable lease. The claim (Slice 5 Task 2/3) already acquired
 *    write leases for the node's DECLARED domains and refused conflicting
 *    activations, so a T2-era node's assertion always passes; a conflicting
 *    lease (a same-domain writer in flight) defers the node — it stays
 *    `completing` and the walk re-drives it in node-run order. Two DISJOINT
 *    domains integrate in PARALLEL: there is no graph-global integrating
 *    slot to contend for;
 * 4. claims the node's own `completing → integrating` status (a per-NODE
 *    claim so a racing window reads `integrating` instead of driving the
 *    same node twice);
 * 5. snapshots the actual diff per physical repository and compares it with
 *    the node's DECLARED writes BEFORE any integration. Under Slice 5 Task 1
 *    the diff is captured from the node's ISOLATED WORKSPACE clone; a node
 *    with no workspace for a domain falls back to the canonical worktree
 *    (the V1 canonical model). An out-of-claim mutation blocks with
 *    `resource-claim-violated` and V1 never silently widens a running node's
 *    claim;
 * 6. integrates valid change sets into the CANONICAL worktree under the
 *    domain's lease, committing each domain's validated paths with the
 *    integration marker. A workspace change set is landed into the canonical
 *    tree as a patch (tracked changes) plus a copy of untracked in-claim
 *    files. A git refusal to land the change set — a diff that no longer
 *    applies (the canonical tree advanced under the node), a failed
 *    add/commit — is `integration-conflict`: BOTH the isolated workspace AND
 *    the canonical worktree are preserved for diagnosis and the graph blocks.
 * 7. after the completed verdict and successor routing commit, invokes the
 *    host's terminal-workspace cleanup. Cleanup is best-effort and can never
 *    rewrite the node or graph verdict.
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
import { resolvePhysicalDomains, type DomainEntry, type PhysicalDomain } from './domains.js';
import {
  captureChangeSet,
  captureUntrackedPaths,
  isPathWithinClaim,
  validateChangeSet,
  type ChangeSetEntry,
} from './changeSet.js';
import { completeActivation } from '../coordinator/completion.js';
import { acquireDomainLeases, releaseLeaseForNodeRun, type ActivationDomain } from '../coordinator/leases.js';
import { releaseProcessSlot } from '../../../store/graph/nodeRuns.js';
import { recordArtifactInstance, validateRequiredOutputs } from '../artifacts/resolve.js';
import { parseGraphDocument } from '../parse.js';
import { emitGraphDiagnostic } from '../diagnostics.js';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

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
  /** The node's isolated workspace clone for a repo (Slice 5 T1); undefined
   *  when the node has none — the V1 canonical-worktree model. The change set
   *  is captured from the clone and landed into the CANONICAL worktree. */
  workspaceCwdOf: (nodeRunId: number, repoName: string) => string | undefined;
  /** Best-effort terminal cleanup, injected by the host so this module stays
   *  filesystem/store agnostic. It must preserve recoverable workspaces. */
  cleanupNodeWorkspace: (input: { graphRunId: number; nodeRunId: number }) => void;
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
 * The one conditional UPDATE that claims the node's integrating status: the
 * node moves `completing → integrating` — a per-NODE claim, so a racing
 * window reads `integrating` instead of driving the same node twice. Slice 5
 * Task 5 REMOVED the graph-global "no OTHER node may be integrating"
 * exclusion: disjoint domains integrate in PARALLEL, and same-domain pairs
 * serialize on the domain LEASE (a conflicting activation cannot hold it), not
 * on a whole-graph slot.
 */
function claimIntegratingStatus(
  deps: CompletionPipelineDeps,
  nodeRunId: number,
): boolean {
  const res = deps.db
    .prepare(
      `UPDATE approach_node_runs
       SET status = 'integrating'
       WHERE id = ? AND status = 'completing'`,
    )
    .run(nodeRunId);
  return res.changes === 1;
}

/**
 * Slice 5 Task 5 — the per-physical-domain serialization guarantee. Before
 * the node may integrate a change set for a domain it must HOLD (or ACQUIRE)
 * that domain's durable lease. A T2/T3-era node already holds write leases
 * for its DECLARED domains (the claim refused conflicting activations), so
 * this is an assertion; a pre-lease node acquires now — refusing (deferring)
 * when a conflicting lease stands, so a same-domain writer in flight keeps
 * this node `completing`. The check + acquire is ONE `BEGIN IMMEDIATE`
 * transaction, so two windows never double-insert the same owner+domain
 * (the `UNIQUE(owner_node_run_id, physical_domain)` index is the backstop).
 * An `ambiguous-process` lease is never integrated over and never re-acquired.
 */
function ensureIntegrationLeases(
  deps: CompletionPipelineDeps,
  graphRunId: number,
  nodeRunId: number,
): boolean {
  const declared = deps.declaredWritesOf(nodeRunId);
  if (declared.length === 0) return true;
  return deps.transaction(() => {
    const db = deps.db;
    const toAcquire: ActivationDomain[] = [];
    for (const domain of declared) {
      const owned = db
        .prepare(
          `SELECT status FROM approach_resource_leases
           WHERE owner_node_run_id = ? AND physical_domain = ?`,
        )
        .get(nodeRunId, domain.domainKey) as { status: string } | undefined;
      if (owned !== undefined) {
        if (owned.status !== 'held') {
          deps.debug?.(
            `[graph] completing node ${nodeRunId}: domain lease ${domain.domainKey} is ${owned.status} — deferring`,
          );
          return false;
        }
        continue; // already held from the claim (Slice 5 Task 2/3)
      }
      toAcquire.push({ physicalDomain: domain.domainKey, accessMode: 'write', paths: domain.paths });
    }
    if (toAcquire.length === 0) return true;
    const acquisition = acquireDomainLeases(
      { db, now: deps.now },
      { graphRunId, nodeRunId, domains: toAcquire },
    );
    if (!acquisition.acquired) {
      deps.debug?.(
        `[graph] completing node ${nodeRunId}: lease refused (${acquisition.reason}) — deferred`,
      );
    }
    return acquisition.acquired;
  });
}

/** One domain's captured change set plus the workspace clones it came from. */
interface DomainCapture {
  entries: ChangeSetEntry[];
  /** The node's workspace clones for this domain; empty = canonical model. */
  workspaceCwds: string[];
}

/**
 * Capture a domain's change set. Under Slice 5 Task 1 the node works in ITS
 * isolated workspace clone(s) — the diff is read from each clone (a domain
 * aliases one or more repos) and merged; only a domain for which the node has
 * NO workspace falls back to the canonical worktree (the V1 canonical model).
 */
async function captureDomainChangeSet(
  deps: CompletionPipelineDeps,
  nodeRunId: number,
  domain: PhysicalDomain,
): Promise<DomainCapture> {
  const workspaceCwds = domain.repoNames
    .map((repoName) => deps.workspaceCwdOf(nodeRunId, repoName))
    .filter((cwd): cwd is string => cwd !== undefined);
  const sources = workspaceCwds.length > 0 ? workspaceCwds : [domain.canonicalWorktree];
  const merged = new Map<string, ChangeSetEntry>();
  for (const cwd of sources) {
    const entries = await captureChangeSet(deps.git, { cwd, baseRef: 'HEAD' });
    for (const entry of entries) {
      if (!merged.has(entry.path)) merged.set(entry.path, entry);
    }
    // A file a node created but never `git add`-ed is invisible to `git diff
    // --name-status` — it must still enter claim validation as an `added`
    // entry, or an out-of-claim untracked file is silently dropped rather
    // than parking the node (the defect this closes). `--exclude-standard`
    // keeps karst's own excluded scaffolding (`.karst/`, `.karst-plugin/`,
    // …) out of both validation and reporting.
    const untracked = await captureUntrackedPaths(deps.git, cwd);
    for (const path of untracked) {
      if (!merged.has(path)) merged.set(path, { path, kind: 'added' });
    }
  }
  return { entries: [...merged.values()], workspaceCwds };
}

type LandResult = { ok: true } | { ok: false; stderr: string; reason: string };

/**
 * Land a workspace-captured change set into the CANONICAL worktree: apply the
 * workspace's `git diff HEAD` patch (tracked changes — renames, deletions and
 * content all ride the patch) and copy the workspace's untracked in-claim
 * files (new files `git diff` never lists, which `git add -A` used to pick
 * up under the V1 model). `git apply --check` runs first, so a patch that
 * cannot land — the canonical tree advanced under the node — touches NOTHING
 * and reports `integration-conflict`: both trees stay exactly as they are.
 */
async function landWorkspaceChanges(
  deps: CompletionPipelineDeps,
  domain: PhysicalDomain,
  paths: readonly string[],
  declaredClaims: readonly string[],
  workspaceCwds: readonly string[],
): Promise<LandResult> {
  const patchDir = mkdtempSync(join(tmpdir(), 'karst-int-'));
  try {
    const patchFile = join(patchDir, 'changes.patch');
    const fragments: string[] = [];
    const untracked: { from: string; rel: string }[] = [];
    for (const cwd of workspaceCwds) {
      const diff = await deps.git(['diff', '--binary', 'HEAD', '--', ...paths], cwd);
      if (diff.exitCode !== 0) {
        return { ok: false, stderr: diff.stderr, reason: 'change-set diff failed' };
      }
      if (diff.stdout.trim() !== '') fragments.push(diff.stdout);
      let untrackedPaths: string[];
      try {
        untrackedPaths = await captureUntrackedPaths(deps.git, cwd);
      } catch (err) {
        return { ok: false, stderr: String(err), reason: 'untracked enumeration failed' };
      }
      for (const rel of untrackedPaths) {
        if (declaredClaims.some((claim) => isPathWithinClaim(rel, claim))) {
          untracked.push({ from: join(cwd, rel), rel });
        }
      }
    }
    if (fragments.length > 0) {
      // Normalize the concatenation to a well-formed patch: each fragment is
      // trimmed at its END and the fragments joined with a single newline —
      // a runner that trims stdout must not leave the last hunk unterminated
      // ("corrupt patch"), and a fragment that already ends with a newline
      // must not double it.
      const patch = fragments.map((f) => f.trimEnd()).join('\n') + '\n';
      writeFileSync(patchFile, patch);
      const check = await deps.git(['apply', '--check', patchFile], domain.canonicalWorktree);
      if (check.exitCode !== 0) {
        return { ok: false, stderr: check.stderr, reason: 'git apply --check refused' };
      }
      const applied = await deps.git(['apply', patchFile], domain.canonicalWorktree);
      if (applied.exitCode !== 0) {
        return { ok: false, stderr: applied.stderr, reason: 'git apply refused' };
      }
    }
    for (const u of untracked) {
      try {
        const target = join(domain.canonicalWorktree, u.rel);
        mkdirSync(dirname(target), { recursive: true });
        copyFileSync(u.from, target);
      } catch (err) {
        return { ok: false, stderr: String(err), reason: 'untracked copy failed' };
      }
    }
    return { ok: true };
  } finally {
    rmSync(patchDir, { recursive: true, force: true });
  }
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

  const revisionId = node.revision_id;
  /** Structured diagnostic for this run, through the injected debug callback. */
  const graphDiag = (
    category: 'completion-rejection' | 'integration',
    detail: string,
  ): string | undefined => {
    return emitGraphDiagnostic({ db: deps.db, debug: deps.debug }, {
      category,
      graphRunId: input.graphRunId,
      revisionId,
      nodeRunId: input.nodeRunId,
      detail,
    });
  };

  graphDiag('integration', 'completing the node — terminating and verifying');
  if (!(await terminationProven(deps, input.nodeRunId))) {
    parkNode(deps, input.nodeRunId, 'completing', 'termination-unknown', {});
    graphDiag('completion-rejection', 'termination not proven — node parked termination-unknown');
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
    graphDiag('completion-rejection', reason);
    parkNode(deps, input.nodeRunId, 'completing', validation.code, {
      outcome: 'complete',
      failureCategory: validation.code,
      reason,
    });
    blockGraphRun(deps, input.graphRunId, reason);
    return { kind: validation.code, artifactId: validation.artifactId, reason };
  }

  // Slice 5 Task 5: PER-PHYSICAL-DOMAIN serialization. The node must hold (or
  // acquire) the lease of every domain it declares writes for BEFORE it may
  // integrate; a conflicting lease (a same-domain writer in flight) defers
  // the node — it stays `completing` and the walk re-drives it in node-run
  // order. Disjoint domains are never contended: there is no graph-global slot.
  if (!ensureIntegrationLeases(deps, input.graphRunId, input.nodeRunId)) {
    return { kind: 'deferred' };
  }

  if (!claimIntegratingStatus(deps, input.nodeRunId)) {
    const now = deps.db
      .prepare('SELECT status FROM approach_node_runs WHERE id = ?')
      .get(input.nodeRunId) as { status: string };
    if (now.status === 'completing') {
      return { kind: 'deferred' }; // a racing window is mid-flight
    }
    return { kind: 'no-op' }; // already moved by a racing window
  }

  // Snapshot + validate. Domains are sorted by key; change sets are captured
  // per domain from the node's ISOLATED workspace clone (Slice 5 T1), falling
  // back to the canonical worktree only when the node has no workspace for a
  // domain (the V1 canonical model), and validated against that domain's
  // declared writes.
  const domains = resolvePhysicalDomains(deps.domainsFor(), deps.gitCommonDirOf);
  const declared = new Map(deps.declaredWritesOf(input.nodeRunId).map((d) => [d.domainKey, d.paths]));
  const captured = new Map<string, DomainCapture>();
  const violations: string[] = [];
  for (const domain of domains) {
    let capture: DomainCapture;
    try {
      capture = await captureDomainChangeSet(deps, input.nodeRunId, domain);
    } catch (err) {
      graphDiag('integration', `change-set capture failed for ${domain.repoNames.join('/')}: ${String(err)}`);
      blockGraphRun(
        deps,
        input.graphRunId,
        `integration-conflict: change-set capture failed for ${domain.repoNames.join('/')}`,
      );
      return { kind: 'integration-conflict', reason: 'change-set capture failed' };
    }
    captured.set(domain.key, capture);
    const validation = validateChangeSet(declared.get(domain.key) ?? [], capture.entries);
    if (!validation.ok) violations.push(...validation.violations);
  }
  if (violations.length > 0) {
    const reason = `resource-claim-violated: ${violations.slice(0, 5).join(', ')}`;
    graphDiag('completion-rejection', reason);
    parkNode(deps, input.nodeRunId, 'integrating', 'blocked', {
      outcome: 'failed',
      failureCategory: 'resource-claim-violated',
      reason,
    });
    blockGraphRun(deps, input.graphRunId, reason);
    return { kind: 'claim-violated', violations };
  }

  // Integrate per domain in sorted-key order. Disjoint domains are INDEPENDENT
  // (the leases serialize same-domain writers); a workspace change set is
  // landed into the CANONICAL worktree under the domain's lease, then the
  // domain's validated paths are committed with the integration marker.
  let committed = false;
  for (const domain of domains) {
    const capture = captured.get(domain.key);
    if (!capture || capture.entries.length === 0) continue;
    const paths = capture.entries.map((e) => e.path);
    if (capture.workspaceCwds.length > 0) {
      const landed = await landWorkspaceChanges(
        deps,
        domain,
        paths,
        declared.get(domain.key) ?? [],
        capture.workspaceCwds,
      );
      if (!landed.ok) {
        const reason = `integration-conflict: ${landed.reason} in ${domain.repoNames.join('/')} (${boundedGitReason(landed.stderr)})`;
        graphDiag('integration', reason);
        parkNode(deps, input.nodeRunId, 'integrating', 'blocked', {
          outcome: 'failed',
          failureCategory: 'integration-conflict',
          reason,
        });
        blockGraphRun(deps, input.graphRunId, reason);
        return { kind: 'integration-conflict', reason: landed.stderr };
      }
    }
    const add = await deps.git(['add', '--all', '--', ...paths], domain.canonicalWorktree);
    if (add.exitCode !== 0) {
      const reason = `integration-conflict: git add refused in ${domain.repoNames.join('/')} (${boundedGitReason(add.stderr)})`;
      graphDiag('integration', reason);
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
      graphDiag('integration', reason);
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
    // Slice 5 Task 3: the node's process provably ended — its slot under the
    // external-process ceiling (`active_processes`) is released with it. This
    // is the ONLY normal-completion release point; a rest state keeps its slot
    // until it is discarded or integrated (conservative — recovery can never
    // oversubscribe real processes).
    releaseProcessSlot(deps.db, input.graphRunId);
  });
  graphDiag('integration', `node integrated${committed ? '' : ' (no changes)'} — completed`);
  try {
    deps.cleanupNodeWorkspace(input);
  } catch (err) {
    // The node is already durably completed and routed. Workspace cleanup is
    // bookkeeping and must never rewrite or reject that terminal verdict.
    deps.debug?.(
      `[graph] workspace cleanup: node ${input.nodeRunId} failed after completion (${err instanceof Error ? err.message : String(err)})`,
    );
  }
  return { kind: 'integrated', committed };
}
