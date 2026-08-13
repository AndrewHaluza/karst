/**
 * Immutable replanning (Slice 4 Task 5): election, drain, and revision N+1.
 *
 * The ten design steps, host-agnostic:
 *
 *   1. `electReplan` elects exactly one initiator with a conditional
 *      `active → draining` revision transition AND `running → draining` run
 *      transition in ONE `BEGIN IMMEDIATE` transaction; only the winner
 *      increments the accepted replan counter. A raced window reads a moved
 *      run → the idempotent no-op `{elected:false, reason:'draining'}`.
 *   2. the coordinator sweep never schedules a non-`running` run, so a
 *      draining revision stops launching new nodes by construction (pinned
 *      in sweep.test.ts).
 *   3. a later replan request while draining is the requesting node's own
 *      bounded row (the CLI records `outcome:'replan'` plus a bounded reason)
 *      — existing evidence, no second planner.
 *   4. `completeActivation` still consumes the claimed token and records the
 *      node's evidence but suppresses ALL successor creation while the
 *      revision is draining (completion.ts).
 *   5. `beginReplanPlannerRun` cancels the draining revision's pending (and
 *      stale claimed) activations once the drain quiesces — no active node
 *      run, no ambiguous lease. Held leases do NOT block quiescence: they are
 *      the deferral source for N+1.
 *   6. exactly one replan `PlannerRun` is allocated transactionally, with the
 *      next monotonic planner-run counter.
 *   7. the launch REQUEST carries ticket context, prior plan/graph snapshots,
 *      completed artifacts, failures, diffs, resource conflicts, and the
 *      elected + secondary replan reasons — the reasons travel as a
 *      content-addressed FILE ARTIFACT through the injected `writeSnapshot`,
 *      never argv, never a shell token.
 *   8. `submitReplanDocument` validates the new document through the injected
 *      compiler; `validateReplanAgainstLeases` turns a still-`held`-lease
 *      overlap into a DEFERRAL list, never a compile failure.
 *   9. revision N+1 is persisted with `supersedes_revision_id` and bounded
 *      rationale; N is superseded — history is never rewritten.
 *  10. N+1's root entry tokens are created and the run resumes scheduling
 *      (`draining → running`).
 *
 * Budget refusal: when the accepted replan count has reached the document's
 * `budgets.maxReplans`, the election is REFUSED rather than attempted — the
 * reporting node's effective outcome becomes `blocked` with reason
 * `graph-budget-exhausted`, the run transitions to `blocked`, and the node's
 * isolation and leases are retained for inspection. Never routed as an
 * unbounded replan, never silently dropped.
 *
 * A planner submission whose revision is no longer draining (a concurrent
 * replan won election while this planner ran) is the idempotent no-op: the
 * late run is marked `stale`, its snapshot is discarded unpersisted, and no
 * revision is created.
 *
 * Host-agnostic: db, transaction, clock, snapshot write, prompt read, the
 * compiler, and the claim→domain resolver are injected; no vscode, no
 * provider, no stage machine.
 */

import type { GraphDb } from '../../../store/graph/transitions.js';
import {
  casStatus,
  GraphStoreError,
  GRAPH_RUN_TRANSITIONS,
  REVISION_TRANSITIONS,
} from '../../../store/graph/transitions.js';
import { activeRevision, createRevision } from '../../../store/graph/revisions.js';
import { transitionPlannerRun } from '../../../store/graph/plannerRuns.js';
import { cancelGraphToken, insertEntryTokens } from '../../../store/graph/tokens.js';
import { nextPlannerIdentity, sha256Hex } from './plannerRun.js';
import { ACTIVE_NODE_STATUSES } from './completion.js';
import { parseGraphDocument, type GraphDocument } from '../parse.js';
import type { CompileResult } from '../compile.js';

/** Bounded launch-input facts (design ceiling rationale: bounded scheduler
 *  and planner inputs; these caps are about the launch REQUEST, never the
 *  evidence store). */
const MAX_ARTIFACT_ROWS = 50;
const MAX_FAILURE_ROWS = 20;
const MAX_DIFF_ROWS = 20;
const MAX_CONFLICT_ROWS = 20;
const MAX_SECONDARY_REASONS = 20;
const MAX_DEFERRED_IDS = 20;
const MAX_RATIONALE_CHARS = 2000;

export interface ReplanDeps {
  db: GraphDb;
  /** BEGIN IMMEDIATE-wrapped, all-or-nothing; a throw rolls back. */
  transaction: <T>(fn: () => T) => T;
  now: () => string;
  debug?: (message: string) => void;
}

export type ElectReplanResult =
  | { elected: true }
  | { elected: false; reason: 'not-running' | 'draining' | 'max-replans-exhausted' };

export interface ElectReplanInput {
  graphRunId: number;
  /** The node run reporting `replan`; its row is the election's evidence
   *  (the budget-refusal path writes its effective outcome here). */
  requestNodeRunId?: number;
}

/**
 * Step 1 — elect exactly one initiator. ONE transaction: read the run, and
 * when it is `running` and the accepted replan count is within the document's
 * `budgets.maxReplans`, CAS `running → draining` (the single-winner gate) and
 * CAS the active revision `active → draining`, incrementing the accepted
 * replan counter. A raced window reads a moved run → `draining` no-op. A
 * later request while draining is the same no-op; its evidence is the
 * requesting node's own row. Exhaustion REFUSES rather than attempts.
 */
export function electReplan(deps: ReplanDeps, input: ElectReplanInput): ElectReplanResult {
  return deps.transaction(() => {
    const db = deps.db;
    const run = db
      .prepare('SELECT status, replan_count FROM approach_graph_runs WHERE id = ?')
      .get(input.graphRunId) as { status: string; replan_count: number } | undefined;
    if (!run) {
      deps.debug?.(`[graph] replan election: run ${input.graphRunId} is gone — no-op`);
      return { elected: false, reason: 'not-running' };
    }
    if (run.status === 'draining') {
      // Step 3: a later request while draining — the node's own row is the
      // bounded evidence; no second planner is launched.
      deps.debug?.(`[graph] replan election: run ${input.graphRunId} already draining — no-op`);
      return { elected: false, reason: 'draining' };
    }
    if (run.status !== 'running') {
      deps.debug?.(
        `[graph] replan election: run ${input.graphRunId} is ${run.status} — no-op`,
      );
      return { elected: false, reason: 'not-running' };
    }
    const revision = activeRevision(db, input.graphRunId);
    if (!revision) {
      deps.debug?.(`[graph] replan election: run ${input.graphRunId} has no active revision — no-op`);
      return { elected: false, reason: 'not-running' };
    }
    const parsed = parseGraphDocument(revision.canonical_graph);
    if (!parsed.ok) {
      deps.debug?.(`[graph] replan election: run ${input.graphRunId} active revision unparseable — no-op`);
      return { elected: false, reason: 'not-running' };
    }

    // Budget refusal: the accepted count has reached the document ceiling.
    // The request is REFUSED, never routed and never dropped — the node's
    // effective outcome becomes blocked, the run blocks, and the node's
    // isolation and leases are retained for inspection.
    if (run.replan_count >= parsed.document.budgets.maxReplans) {
      if (input.requestNodeRunId !== undefined) {
        db.prepare(
          `UPDATE approach_node_runs
           SET effective_outcome = 'blocked', failure_category = 'graph-budget-exhausted',
               reason = 'graph-budget-exhausted'
           WHERE id = ? AND graph_run_id = ?`,
        ).run(input.requestNodeRunId, input.graphRunId);
      }
      if (
        casStatus(db, 'approach_graph_runs', GRAPH_RUN_TRANSITIONS, input.graphRunId, 'running', 'blocked')
      ) {
        db.prepare(
          'UPDATE approach_graph_runs SET blocked_reason = ?, updated_at = ? WHERE id = ?',
        ).run('graph-budget-exhausted', deps.now(), input.graphRunId);
      }
      deps.debug?.(
        `[graph] replan election: run ${input.graphRunId} replan budget exhausted — refused, blocked graph-budget-exhausted`,
      );
      return { elected: false, reason: 'max-replans-exhausted' };
    }

    // Step 1's single-winner election: the run CAS is the gate. A raced
    // window's CAS moves 0 rows → the whole transaction is the idempotent
    // no-op `{elected:false, reason:'draining'}`.
    if (
      !casStatus(db, 'approach_graph_runs', GRAPH_RUN_TRANSITIONS, input.graphRunId, 'running', 'draining')
    ) {
      deps.debug?.(`[graph] replan election: run ${input.graphRunId} already moved — raced, no-op`);
      return { elected: false, reason: 'draining' };
    }
    if (
      !casStatus(db, 'approach_graph_revisions', REVISION_TRANSITIONS, revision.id, 'active', 'draining')
    ) {
      // Under BEGIN IMMEDIATE this cannot race; if it did, roll back both.
      throw new GraphStoreError(
        `replan election: revision ${revision.id} not active while run ${input.graphRunId} was running`,
      );
    }
    db.prepare(
      'UPDATE approach_graph_runs SET replan_count = replan_count + 1, updated_at = ? WHERE id = ?',
    ).run(deps.now(), input.graphRunId);
    deps.debug?.(
      `[graph] replan election: run ${input.graphRunId} elected — draining revision ${revision.id} (accepted replans ${run.replan_count + 1})`,
    );
    return { elected: true };
  });
}

export interface ReplanLaunchDeps extends ReplanDeps {
  /** Content-addressed write under the graph run's snapshot root. */
  writeSnapshot: (graphRunId: number, relativePath: string, bytes: Uint8Array) => void;
  /** Returns the effective prompt bytes, or undefined when unreadable. */
  readPrompt: (path: string) => Uint8Array | undefined;
  promptPath: string;
  /** The packaged ticket context the replanner is seeded with (host-built). */
  ticketContext: string;
}

/** Step 7's launch REQUEST — the durable, bounded facts a replanner needs.
 *  The reasons travel as a file artifact (`reasonsSnapshotPath`), never argv. */
export interface ReplanLaunchRequest {
  graphRunId: number;
  plannerRunId: number;
  plannerRunNumber: number;
  /** The draining revision this replan supersedes. */
  supersedesRevisionId: number;
  priorRevisionNumber: number;
  priorGraphSnapshotId: string | null;
  priorArtifactSnapshotId: string | null;
  promptSnapshotPath: string;
  promptHash: string;
  reasonsSnapshotPath: string;
  ticketContext: string;
  completedArtifacts: { artifactId: string; snapshotPath: string }[];
  failures: { nodeId: string; category: string | null; reason: string | null }[];
  diffs: string[];
  resourceConflicts: { physicalDomain: string; ownerNodeId: string }[];
}

export type BeginReplanResult =
  | { ok: true; plannerRunId: number; plannerRunNumber: number; launch: ReplanLaunchRequest }
  | { ok: false; reason: 'not-draining' | 'not-quiescent' | 'instructions-missing' };

/** The drain's active-work quiescence: no non-terminal node run and no held
 *  ambiguous-process lease. Held (`held`) leases are deliberately NOT a block
 *  — they are the deferral source: N+1 validates against them and schedules
 *  conflicting nodes later. A `termination-unknown` holder stays in
 *  `ACTIVE_NODE_STATUSES`, so its never-releasing lease keeps the drain
 *  waiting — the discard action (Task 4) is the named exit. */
function replanQuiescenceBlockedBy(db: GraphDb, graphRunId: number): string | null {
  const active = db
    .prepare(
      `SELECT COUNT(*) AS n FROM approach_node_runs
       WHERE graph_run_id = ? AND status IN (${ACTIVE_NODE_STATUSES.map(() => '?').join(',')})`,
    )
    .all(graphRunId, ...ACTIVE_NODE_STATUSES) as { n: number }[];
  if ((active[0]?.n ?? 0) > 0) return 'active-node-runs';
  const leases = db
    .prepare(
      `SELECT COUNT(*) AS n FROM approach_resource_leases
       WHERE graph_run_id = ? AND status = 'ambiguous-process'`,
    )
    .get(graphRunId) as { n: number };
  if (leases.n > 0) return 'ambiguous-lease';
  return null;
}

/**
 * Steps 5–7 — once the drain quiesces, allocate exactly one replan
 * `PlannerRun` transactionally and produce the launch REQUEST. In ONE
 * transaction: verify the run is still `draining` (a concurrent replan that
 * already landed N+1 is a no-op), require quiescence, cancel the draining
 * revision's pending activations, snapshot the prompt, write the elected +
 * secondary replan reasons as a FILE ARTIFACT, and record the reasons path on
 * the planner run (the launch-input snapshot; submit copies it onto N+1).
 */
export function beginReplanPlannerRun(
  deps: ReplanLaunchDeps,
  input: { graphRunId: number },
): BeginReplanResult {
  return deps.transaction(() => {
    const db = deps.db;
    const run = db
      .prepare('SELECT status FROM approach_graph_runs WHERE id = ?')
      .get(input.graphRunId) as { status: string } | undefined;
    if (!run || run.status !== 'draining') {
      deps.debug?.(
        `[graph] replan begin: run ${input.graphRunId} is ${run?.status ?? 'gone'} — no-op`,
      );
      return { ok: false, reason: 'not-draining' };
    }
    const revision = db
      .prepare(
        `SELECT id, revision_number, planner_graph_snapshot_id, planner_artifact_snapshot_id
         FROM approach_graph_revisions
         WHERE graph_run_id = ? AND status = 'draining'`,
      )
      .get(input.graphRunId) as {
      id: number;
      revision_number: number;
      planner_graph_snapshot_id: string | null;
      planner_artifact_snapshot_id: string | null;
    } | undefined;
    if (!revision) return { ok: false, reason: 'not-draining' };

    // Step 6's quiescence gate: exactly one PlannerRun, and only after the
    // drain quiesces. A caller that is not quiescent yet gets a bounded
    // refusal and retries later — the planner is never allocated early.
    const blockedBy = replanQuiescenceBlockedBy(db, input.graphRunId);
    if (blockedBy) {
      deps.debug?.(
        `[graph] replan begin: run ${input.graphRunId} not quiescent (${blockedBy}) — planner deferred`,
      );
      return { ok: false, reason: 'not-quiescent' };
    }

    // Step 5: cancel the draining revision's pending (and any stale claimed)
    // activations — the superseded revision must not leave orphaned tokens.
    const pending = db
      .prepare(
        `SELECT id FROM approach_graph_tokens
         WHERE revision_id = ? AND status IN ('pending', 'claimed')`,
      )
      .all(revision.id) as { id: number }[];
    let cancelled = 0;
    for (const token of pending) {
      if (cancelGraphToken(db, token.id)) cancelled += 1;
    }

    const promptBytes = deps.readPrompt(deps.promptPath);
    if (promptBytes === undefined) {
      deps.debug?.(
        `[graph] replan begin: run ${input.graphRunId} prompt unreadable — instructions-missing`,
      );
      return { ok: false, reason: 'instructions-missing' };
    }
    const promptHash = sha256Hex(promptBytes);
    const promptSnapshotPath = `prompts/${promptHash}`;

    // Step 6: allocate exactly one replan PlannerRun with the next counter.
    const identity = nextPlannerIdentity(db, input.graphRunId);
    if (!identity) return { ok: false, reason: 'not-draining' };
    db.prepare(
      'UPDATE approach_planner_runs SET prompt_hash = ?, artifact_snapshot_id = ? WHERE id = ?',
    ).run(promptHash, promptSnapshotPath, identity.plannerRunId);
    deps.writeSnapshot(input.graphRunId, promptSnapshotPath, promptBytes);

    // Step 7: the elected + secondary replan reasons. The elected reason is
    // the first node that reported `replan`; later requests while draining
    // are the secondary reasons — all read from the draining revision's own
    // node runs (the CLI records `outcome:'replan'` + a bounded reason). The
    // reasons travel as a content-addressed FILE ARTIFACT — never argv, never
    // a shell token — and the planner prompt frames them as untrusted
    // agent-reported text.
    const reasonRows = db
      .prepare(
        `SELECT node_id, reason FROM approach_node_runs
         WHERE graph_run_id = ? AND outcome = 'replan'
         ORDER BY id`,
      )
      .all(input.graphRunId) as { node_id: string; reason: string | null }[];
    const reasonsDoc = {
      elected: reasonRows.slice(0, 1).map((r) => ({ node: r.node_id, reason: r.reason })),
      secondary: reasonRows
        .slice(1, 1 + MAX_SECONDARY_REASONS)
        .map((r) => ({ node: r.node_id, reason: r.reason })),
    };
    const reasonsBytes = new TextEncoder().encode(JSON.stringify(reasonsDoc));
    const reasonsSnapshotPath = `reasons/${sha256Hex(reasonsBytes)}.json`;
    deps.writeSnapshot(input.graphRunId, reasonsSnapshotPath, reasonsBytes);
    db.prepare('UPDATE approach_planner_runs SET graph_snapshot_id = ? WHERE id = ?').run(
      reasonsSnapshotPath,
      identity.plannerRunId,
    );

    // Bounded launch-input facts read from durable evidence.
    const completedArtifacts = db
      .prepare(
        `SELECT artifact_id, snapshot_path FROM approach_artifact_instances
         WHERE graph_run_id = ? ORDER BY id LIMIT ${MAX_ARTIFACT_ROWS}`,
      )
      .all(input.graphRunId) as { artifact_id: string; snapshot_path: string }[];
    const failures = db
      .prepare(
        `SELECT node_id, failure_category, reason FROM approach_node_runs
         WHERE graph_run_id = ?
           AND (failure_category IS NOT NULL
                OR outcome IN ('failed','not-matched','infrastructure-error',
                               'resource-claim-violated','integration-conflict'))
         ORDER BY id LIMIT ${MAX_FAILURE_ROWS}`,
      )
      .all(input.graphRunId) as { node_id: string; failure_category: string | null; reason: string | null }[];
    const diffs = db
      .prepare(
        `SELECT change_set_id FROM approach_node_runs
         WHERE graph_run_id = ? AND change_set_id IS NOT NULL
         ORDER BY id LIMIT ${MAX_DIFF_ROWS}`,
      )
      .all(input.graphRunId) as { change_set_id: string }[];
    const resourceConflicts = db
      .prepare(
        `SELECT owner_node_run_id, physical_domain FROM approach_resource_leases
         WHERE graph_run_id = ? AND status = 'held'
         ORDER BY id LIMIT ${MAX_CONFLICT_ROWS}`,
      )
      .all(input.graphRunId) as { owner_node_run_id: number; physical_domain: string }[];

    const launch: ReplanLaunchRequest = {
      graphRunId: input.graphRunId,
      plannerRunId: identity.plannerRunId,
      plannerRunNumber: identity.plannerRunNumber,
      supersedesRevisionId: revision.id,
      priorRevisionNumber: revision.revision_number,
      priorGraphSnapshotId: revision.planner_graph_snapshot_id,
      priorArtifactSnapshotId: revision.planner_artifact_snapshot_id,
      promptSnapshotPath,
      promptHash,
      reasonsSnapshotPath,
      ticketContext: deps.ticketContext,
      completedArtifacts: completedArtifacts.map((a) => ({
        artifactId: a.artifact_id,
        snapshotPath: a.snapshot_path,
      })),
      failures: failures.map((f) => ({
        nodeId: f.node_id,
        category: f.failure_category,
        reason: f.reason,
      })),
      diffs: diffs.map((d) => d.change_set_id),
      resourceConflicts: resourceConflicts.map((c) => ({
        physicalDomain: c.physical_domain,
        ownerNodeId: String(c.owner_node_run_id),
      })),
    };
    deps.debug?.(
      `[graph] replan begin: run ${input.graphRunId} planner run ${identity.plannerRunId} (#${identity.plannerRunNumber}) — cancelled ${cancelled} activation(s), ${reasonsDoc.secondary.length} secondary reason(s)`,
    );
    return {
      ok: true,
      plannerRunId: identity.plannerRunId,
      plannerRunNumber: identity.plannerRunNumber,
      launch,
    };
  });
}

export interface SubmitReplanDeps extends ReplanDeps {
  /** Host-side compile (profiles, commands, repositories, expert spend,
   *  project maxima, artifact-file existence). Compilation does NOT consult
   *  held leases — a lease overlap is a deferral, never a compile error. */
  compileDocument: (document: GraphDocument) => CompileResult;
  /** Resolve a document node's resource claims to physical-domain keys. */
  physicalDomainsOf: (nodeId: string) => string[];
}

export interface SubmitReplanInput {
  plannerRunId: number;
  document: GraphDocument;
  /** Bounded rationale recorded on revision N+1. */
  rationale: string;
}

export type SubmitReplanResult =
  | { ok: true; revisionId: number; revisionNumber: number; deferredNodeIds: string[] }
  | { ok: false; reason: 'not-found' | 'not-draining' | 'invalid-document' };

/**
 * The deferral rule: revision N+1's resource claims are validated against the
 * still-`held` leases from the draining revision N. A conflicting node is
 * DEFERRED — its entry token is still created, but the scheduler's
 * resource-claim check naturally waits for the lease to release — never a
 * compile failure. Bounded, deterministic node-id list.
 */
export function validateReplanAgainstLeases(
  db: GraphDb,
  graphRunId: number,
  document: GraphDocument,
  physicalDomainsOf: (nodeId: string) => string[],
): string[] {
  const held = db
    .prepare(
      `SELECT physical_domain FROM approach_resource_leases
       WHERE graph_run_id = ? AND status = 'held'`,
    )
    .all(graphRunId) as { physical_domain: string }[];
  const domains = new Set(held.map((h) => h.physical_domain));
  if (domains.size === 0) return [];
  const deferred: string[] = [];
  for (const node of document.nodes) {
    if (physicalDomainsOf(node.id).some((d) => domains.has(d))) deferred.push(node.id);
  }
  return [...new Set(deferred)].sort();
}

/**
 * Steps 8–10 — validate the new document, persist revision N+1, supersede N
 * without rewriting history, and resume scheduling. A submission whose
 * revision is no longer draining is the idempotent late no-op: the planner
 * run is marked `stale`, its snapshot is discarded unpersisted, and no
 * revision is created.
 */
export function submitReplanDocument(
  deps: SubmitReplanDeps,
  input: SubmitReplanInput,
): SubmitReplanResult {
  return deps.transaction(() => {
    const db = deps.db;
    const planner = db
      .prepare('SELECT graph_run_id, status, graph_snapshot_id FROM approach_planner_runs WHERE id = ?')
      .get(input.plannerRunId) as
      | { graph_run_id: number; status: string; graph_snapshot_id: string | null }
      | undefined;
    if (!planner) return { ok: false, reason: 'not-found' };
    const graphRunId = planner.graph_run_id;
    const run = db
      .prepare('SELECT status FROM approach_graph_runs WHERE id = ?')
      .get(graphRunId) as { status: string } | undefined;

    // A submission whose revision is no longer draining is LATE: a concurrent
    // replan won election and landed N+1 while this planner ran. Mark the
    // late run `stale`, discard its snapshot unpersisted, create nothing.
    if (!run || run.status !== 'draining') {
      const from =
        planner.status === 'running'
          ? 'running'
          : planner.status === 'ready'
            ? 'ready'
            : planner.status === 'launching'
              ? 'launching'
              : null;
      if (from) {
        transitionPlannerRun(db, input.plannerRunId, from, 'stale');
        db.prepare('UPDATE approach_planner_runs SET ended_at = ? WHERE id = ?').run(
          deps.now(),
          input.plannerRunId,
        );
      }
      deps.debug?.(
        `[graph] replan submit: planner run ${input.plannerRunId} is late (run ${graphRunId} is ${run?.status ?? 'gone'}) — marked stale, no revision`,
      );
      return { ok: false, reason: 'not-draining' };
    }

    // Step 8: validate a complete new graph document. Held-lease overlap is a
    // deferral, never a compile failure — the compiler does not see leases.
    const compiled = deps.compileDocument(input.document);
    if (!compiled.ok) {
      deps.debug?.(`[graph] replan submit: planner run ${input.plannerRunId} document rejected`);
      return { ok: false, reason: 'invalid-document' };
    }
    const deferredNodeIds = validateReplanAgainstLeases(
      db,
      graphRunId,
      input.document,
      deps.physicalDomainsOf,
    );

    const revision = db
      .prepare(
        `SELECT id, revision_number FROM approach_graph_revisions
         WHERE graph_run_id = ? AND status = 'draining'`,
      )
      .get(graphRunId) as { id: number; revision_number: number } | undefined;
    if (!revision) return { ok: false, reason: 'not-draining' };

    // Step 9: persist revision N+1. The old revision is superseded FIRST —
    // the partial unique index admits at most one active revision per run,
    // and this transaction is the one place both move together.
    if (
      !casStatus(db, 'approach_graph_revisions', REVISION_TRANSITIONS, revision.id, 'draining', 'superseded')
    ) {
      return { ok: false, reason: 'not-draining' };
    }
    db.prepare('UPDATE approach_graph_revisions SET superseded_at = ? WHERE id = ?').run(
      deps.now(),
      revision.id,
    );
    const nextNumber = db
      .prepare(
        'SELECT COALESCE(MAX(revision_number), 0) + 1 AS next FROM approach_graph_revisions WHERE graph_run_id = ?',
      )
      .get(graphRunId) as { next: number };
    const newRevisionId = createRevision(db, {
      graphRunId,
      revisionNumber: nextNumber.next,
      canonicalGraph: compiled.compiled.canonicalJson,
      fingerprint: compiled.compiled.fingerprint,
      status: 'active',
      now: deps.now(),
      supersedesRevisionId: revision.id,
      reason: input.rationale.slice(0, MAX_RATIONALE_CHARS),
    });

    // The submitted graph snapshot and the launch-input reasons file both land
    // on the revision (immutable planner inputs); the planner run records the
    // submitted graph snapshot once.
    const graphSnapshotId = compiled.compiled.fingerprint;
    db.prepare(
      `UPDATE approach_graph_revisions
       SET planner_graph_snapshot_id = ?, planner_artifact_snapshot_id = ?
       WHERE id = ?`,
    ).run(graphSnapshotId, planner.graph_snapshot_id ?? null, newRevisionId);
    if (deferredNodeIds.length > 0) {
      db.prepare('UPDATE approach_planner_runs SET reason = ? WHERE id = ?').run(
        `deferred-on-held-leases: ${deferredNodeIds.slice(0, MAX_DEFERRED_IDS).join(',')}`,
        input.plannerRunId,
      );
    }
    if (planner.status === 'running') {
      transitionPlannerRun(db, input.plannerRunId, 'running', 'submitted');
      db.prepare(
        'UPDATE approach_planner_runs SET graph_snapshot_id = ?, submitted_at = ? WHERE id = ?',
      ).run(graphSnapshotId, deps.now(), input.plannerRunId);
    }

    // Step 10: create the new root fork/entry tokens and resume scheduling.
    insertEntryTokens(
      db,
      newRevisionId,
      input.document.entries.map((nodeId) => ({
        edgeId: `entry-${nodeId}`,
        destinationNodeId: nodeId,
        destinationEnd: false,
      })),
      deps.now(),
    );
    if (
      !casStatus(db, 'approach_graph_runs', GRAPH_RUN_TRANSITIONS, graphRunId, 'draining', 'running')
    ) {
      // Structurally unreachable under BEGIN IMMEDIATE; roll back rather than
      // commit an active revision on a run the sweep will never schedule.
      throw new GraphStoreError(`replan submit: run ${graphRunId} left draining mid-transaction`);
    }

    deps.debug?.(
      `[graph] replan submit: run ${graphRunId} revision ${newRevisionId} (#${nextNumber.next}) supersedes ${revision.id} — ${deferredNodeIds.length} deferred node(s)`,
    );
    return {
      ok: true,
      revisionId: newRevisionId,
      revisionNumber: nextNumber.next,
      deferredNodeIds,
    };
  });
}
