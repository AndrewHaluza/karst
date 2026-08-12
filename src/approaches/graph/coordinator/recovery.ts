/**
 * Graph recovery (Slice 3 Task 9 + Slice 4 Task 6 — category-specific).
 *
 * The typed `graph-recovery` action resolves here. The design's recovery
 * table is implemented as a TOTAL function over the closed category set:
 * `recoveryCategoryFor(blockedReason)` maps every `blocked_reason` the
 * coordinator can write to exactly one `RecoveryCategory`, and
 * `recoverGraphRun` dispatches on it (a `switch` whose `never` default
 * throws — an unmapped reason is a defect, never a silent retry).
 *
 * Every "retry the same reserved visit" action is the node-run transition
 * `failed-to-launch` / `blocked` / `stale` → `launching`: the token stays
 * `claimed` (there is deliberately no `claimed → pending` transition), no
 * second visit is allocated, and only the launch-attempt counter moves.
 * A LAUNCH retry does NOT re-snapshot the prompt; an EXPLICIT prompt Resume
 * (a blocked agent node carrying a `prompt` override, or a reason that names
 * prompt configuration) re-snapshots the effective prompt bytes first.
 *
 * Category → action:
 *   launch-retry        retry the same reserved visit, latest late-bound
 *                       configuration, new launch attempt, no re-snapshot
 *   prompt-resnapshot   re-snapshot the effective prompt bytes, then retry
 *   replan / compile-new-revision
 *                       elect + begin a new planner run (Slice-4 T5),
 *                       subject to the planner/replan budget; a budget
 *                       refusal blocks the reporting node
 *                       `graph-budget-exhausted` and is REFUSED here
 *   discard-required    launch-unknown / termination-unknown — never
 *                       auto-retried; the T4 discard is the named exit
 *   config-then-resume  budget exhaustion — configuration change within
 *                       hard caps, then explicit Resume
 *   explicit-resolution integration conflict, output/artifact/resource-claim
 *                       faults, topology deadlock, unrecognized reasons —
 *                       corrected artifacts/claims or replan/expert
 *                       diagnosis, then explicit Resume
 *
 * The retry happens in ONE `BEGIN IMMEDIATE` transaction: it CAS-claims the
 * BLOCKED graph run (`blocked → running`), re-snapshots the prompt hash on
 * the reserved runs the explicit prompt Resume covers, moves every blocked
 * node run `→ launching`, bumps each launch attempt, and clears the visible
 * `approach-graph-failed` stage block ONLY after the retry has durably
 * entered that recoverable state. The replan categories claim the run the
 * same way, then hand the election + planner allocation to replan.ts.
 *
 * Node overrides (Slice 4 Task 6): scoped `(revision, node, kind)`, editable
 * only while the node has no claimed/launched run; the store helpers in
 * `store/graph/nodeRuns.ts` own the CAS. Recovery consults them to decide
 * the explicit prompt Resume and reads the effective prompt through the
 * injected `resolveEffective` seam — the host binds it to the real
 * packaged/override overlay. Recovery itself never mutates an override.
 *
 * Host-agnostic: store + transaction + clock + the prompt/replan seams
 * injected; no vscode, no provider, no stage machine.
 */

import type { Store } from '../../../store/db.js';
import { clearStageBlock, stageBlock } from '../../../store/stageBlocks.js';
import { getTicket } from '../../../store/tickets.js';
import { casStatus, GRAPH_RUN_TRANSITIONS, NODE_RUN_TRANSITIONS } from '../../../store/graph/transitions.js';
import { nodeOverrideFor } from '../../../store/graph/nodeRuns.js';
import { incrementLaunchAttempt } from './claim.js';
import { sha256Hex } from './plannerRun.js';
import {
  beginReplanPlannerRun,
  electReplan,
  type ReplanDeps,
  type ReplanLaunchDeps,
  type ReplanLaunchRequest,
} from './replan.js';
import { emitGraphDiagnostic } from '../diagnostics.js';

/** The one graph blocker kind (defined here, on the graph side; the stage
 *  boundary module and the model's `BlockerKind` refer to this string). */
export const GRAPH_FAILED_BLOCKER = 'approach-graph-failed' as const;

/** The closed recovery-category set — the design's recovery table as a total
 *  function over the `blocked_reason` values the coordinator can write. */
export type RecoveryCategory =
  | 'launch-retry'
  | 'prompt-resnapshot'
  | 'replan'
  | 'compile-new-revision'
  | 'discard-required'
  | 'config-then-resume'
  | 'explicit-resolution';

/** The closed refusal reasons a `refused` recovery returns. */
export type RecoveryRefusalReason =
  | 'discard-required'
  | 'config-then-resume'
  | 'explicit-resolution';

export interface RecoveryDeps {
  store: Store;
  /** BEGIN IMMEDIATE-wrapped, all-or-nothing; a throw rolls back. */
  transaction: <T>(fn: () => T) => T;
  now: () => string;
  debug?: (message: string) => void;
  /**
   * The effective node prompt TEXT for a node's next launch (the packaged
   * base prompt overlaid with the project override and any per-node `prompt`
   * override), or `{promptOverride:false}` when the node has no prompt
   * override. The explicit prompt Resume re-snapshots these bytes; absent,
   * the prompt category refuses rather than silently skipping the re-snapshot.
   */
  resolveEffective?: (input: {
    graphRunId: number;
    revisionId: number;
    nodeId: string;
    nodeKind: string;
  }) => EffectiveNodeConfig;
  /** Content-addressed write under the graph run's snapshot root. */
  writeSnapshot?: (graphRunId: number, relativePath: string, bytes: Uint8Array) => void;
  /** Replan launch inputs (Slice-4 T5). Absent → the replan election still
   *  drains the run, but the planner allocation is deferred to the host. */
  readPrompt?: (path: string) => Uint8Array | undefined;
  plannerPromptPath?: string;
  ticketContext?: string;
}

export interface EffectiveNodeConfig {
  /** The effective node prompt bytes as text, or undefined when unreadable. */
  prompt?: string;
  /** Whether a per-node `prompt` override is active — the explicit-prompt
   *  Resume signal (re-snapshot, never a silent same-bytes retry). */
  promptOverride: boolean;
}

export type RecoveryResult =
  | { kind: 'retried'; retried: number[]; resnapshotted: number[] }
  | {
      kind: 'replanned';
      plannerRunId: number | null;
      plannerRunNumber: number | null;
      launch: ReplanLaunchRequest | null;
    }
  | { kind: 'refused'; reason: RecoveryRefusalReason }
  | { kind: 'no-op' };

interface BlockedRunRow {
  id: number;
  status: string;
  blocked_reason: string | null;
}

interface BlockedNodeRow {
  id: number;
  revision_id: number;
  node_id: string;
  node_kind: string;
  status: string;
}

/**
 * The total function over the closed category set: every `blocked_reason`
 * prefix the coordinator can write maps to exactly one `RecoveryCategory`.
 * Order is load-bearing — `termination-unknown` is checked before the
 * `node-blocked` prefix because the permanent-stall class must never read as
 * a retry. An unrecognized reason is `explicit-resolution`: never auto-retried.
 */
export function recoveryCategoryFor(reason: string | null): RecoveryCategory {
  if (!reason) return 'explicit-resolution';
  if (reason.includes('termination-unknown')) return 'discard-required';
  if (reason.startsWith('launch-unknown')) return 'discard-required';
  if (reason.startsWith('graph-budget-exhausted')) return 'config-then-resume';
  if (reason.startsWith('node-blocked')) return 'launch-retry';
  if (reason.startsWith('failed-to-launch')) return 'launch-retry';
  if (reason.startsWith('graph-plan-invalid')) return 'replan';
  if (reason.startsWith('planner-artifact-missing')) return 'replan';
  if (reason.startsWith('instructions-missing')) return 'replan';
  if (reason.startsWith('command-definition-changed')) return 'compile-new-revision';
  if (reason.startsWith('prompt-config-changed')) return 'prompt-resnapshot';
  if (reason.startsWith('output-artifact-missing')) return 'explicit-resolution';
  if (reason.startsWith('artifact-unsafe')) return 'explicit-resolution';
  if (reason.startsWith('resource-claim-violated')) return 'explicit-resolution';
  if (reason.startsWith('integration-conflict')) return 'explicit-resolution';
  if (reason.startsWith('graph-topology-deadlock')) return 'explicit-resolution';
  return 'explicit-resolution';
}

function blockedNodeRows(db: RecoveryDeps['store']['db'], graphRunId: number): BlockedNodeRow[] {
  return db
    .prepare(
      `SELECT id, revision_id, node_id, node_kind, status FROM approach_node_runs
       WHERE graph_run_id = ? AND status IN ('blocked','failed-to-launch','stale')
       ORDER BY id`,
    )
    .all(graphRunId) as BlockedNodeRow[];
}

/** Whether a node is covered by the explicit prompt Resume: its own `prompt`
 *  override, or a reason that names prompt configuration. */
function nodeNeedsPromptResnapshot(
  deps: RecoveryDeps,
  category: RecoveryCategory,
  node: BlockedNodeRow,
): boolean {
  if (node.node_kind !== 'agent') return false;
  if (category === 'prompt-resnapshot') return true;
  return nodeOverrideFor(deps.store.db, node.revision_id, node.node_id, 'prompt') !== undefined;
}

/** Re-snapshot a node's effective prompt bytes; returns the new hash, or null
 *  when the effective prompt is unresolvable (the caller must refuse). */
function resnapshotPromptHash(
  deps: RecoveryDeps,
  graphRunId: number,
  node: BlockedNodeRow,
): string | null {
  if (!deps.resolveEffective || !deps.writeSnapshot) return null;
  const effective = deps.resolveEffective({
    graphRunId,
    revisionId: node.revision_id,
    nodeId: node.node_id,
    nodeKind: node.node_kind,
  });
  if (effective.prompt === undefined) return null;
  const bytes = new TextEncoder().encode(effective.prompt);
  const hash = sha256Hex(bytes);
  deps.writeSnapshot(graphRunId, `prompts/${hash}`, bytes);
  return hash;
}

/**
 * The launch-retry / prompt-resnapshot action. In ONE transaction the blocked
 * run re-opens (`blocked → running`), every blocked node run moves
 * `→ launching` (token stays claimed, launch attempt bumps), and the visible
 * stage block clears only after the retry durably entered. Prompt re-snapshots
 * land as content-addressed bytes BEFORE the transaction (idempotent writes;
 * the DB transition is the atomic claim) and are recorded on the reserved
 * runs inside it.
 */
function retryReservedVisits(
  deps: RecoveryDeps,
  input: { ticketId: number; graphRunId: number },
  category: RecoveryCategory,
): RecoveryResult {
  const db = deps.store.db;
  const nodes = blockedNodeRows(db, input.graphRunId);

  const snapshots = new Map<number, string>();
  for (const node of nodes) {
    if (!nodeNeedsPromptResnapshot(deps, category, node)) continue;
    const hash = resnapshotPromptHash(deps, input.graphRunId, node);
    if (hash === null) {
      emitGraphDiagnostic({ db, debug: deps.debug }, {
        category: 'recovery',
        graphRunId: input.graphRunId,
        detail: `refused (explicit-resolution): prompt re-snapshot unresolvable for node ${node.id}`,
      });
      return { kind: 'refused', reason: 'explicit-resolution' };
    }
    snapshots.set(node.id, hash);
  }

  const retried: number[] = [];
  const resnapshotted: number[] = [];
  const outcome = deps.transaction(() => {
    if (
      !casStatus(db, 'approach_graph_runs', GRAPH_RUN_TRANSITIONS, input.graphRunId, 'blocked', 'running')
    ) {
      return false; // a racing window claimed it
    }
    db.prepare('UPDATE approach_graph_runs SET blocked_reason = NULL, updated_at = ? WHERE id = ?').run(
      deps.now(),
      input.graphRunId,
    );
    for (const node of nodes) {
      const hash = snapshots.get(node.id);
      if (hash !== undefined) {
        db.prepare('UPDATE approach_node_runs SET prompt_hash = ? WHERE id = ?').run(hash, node.id);
        resnapshotted.push(node.id);
      }
      if (
        casStatus(db, 'approach_node_runs', NODE_RUN_TRANSITIONS, node.id, node.status, 'launching')
      ) {
        incrementLaunchAttempt(db, node.id);
        retried.push(node.id);
      }
    }
    // The stage block clears only now, INSIDE the same transaction: the retry
    // has durably entered a recoverable state.
    const block = stageBlock(deps.store, input.ticketId, 'impl');
    if (block && block.kind === GRAPH_FAILED_BLOCKER) {
      clearStageBlock(deps.store, input.ticketId, 'impl');
    }
    return true;
  });
  if (!outcome) return { kind: 'no-op' };
  emitGraphDiagnostic({ db, debug: deps.debug }, {
    category: 'recovery',
    graphRunId: input.graphRunId,
    detail: `retried (${retried.join(',') || 'none'}${resnapshotted.length ? `, ${resnapshotted.length} prompt re-snapshot(s)` : ''}) — stage block cleared`,
  });
  return { kind: 'retried', retried, resnapshotted };
}

/**
 * The replan / compile-new-revision action (Slice-4 T5 machinery). The blocked
 * run is atomically re-opened, then `electReplan` drains it (subject to the
 * document's replan budget); the stage block clears only once the run has
 * durably left `blocked`. Budget exhaustion is REFUSED — the election already
 * blocked the reporting node with `graph-budget-exhausted`.
 */
function replanRecovery(
  deps: RecoveryDeps,
  input: { ticketId: number; graphRunId: number },
): RecoveryResult {
  const db = deps.store.db;

  // A replan has nothing to drain without an active revision; refusing here
  // (rather than leaving the re-opened run dangling) keeps the exit honest.
  const hasActiveRevision =
    db
      .prepare(
        "SELECT id FROM approach_graph_revisions WHERE graph_run_id = ? AND status = 'active'",
      )
      .get(input.graphRunId) !== undefined;
  if (!hasActiveRevision) {
    emitGraphDiagnostic({ db, debug: deps.debug }, {
      category: 'recovery',
      graphRunId: input.graphRunId,
      detail: 'refused (explicit-resolution): replan requires an active revision',
    });
    return { kind: 'refused', reason: 'explicit-resolution' };
  }

  const claimed = deps.transaction(() => {
    if (
      !casStatus(db, 'approach_graph_runs', GRAPH_RUN_TRANSITIONS, input.graphRunId, 'blocked', 'running')
    ) {
      return false;
    }
    db.prepare('UPDATE approach_graph_runs SET blocked_reason = NULL, updated_at = ? WHERE id = ?').run(
      deps.now(),
      input.graphRunId,
    );
    return true;
  });
  if (!claimed) return { kind: 'no-op' };

  const firstBlocked = db
    .prepare(
      `SELECT id FROM approach_node_runs
       WHERE graph_run_id = ? AND status IN ('blocked','failed-to-launch','stale')
       ORDER BY id LIMIT 1`,
    )
    .get(input.graphRunId) as { id: number } | undefined;

  const replanDeps: ReplanDeps = {
    db,
    transaction: deps.transaction,
    now: deps.now,
    debug: deps.debug,
  };
  const elected = electReplan(replanDeps, {
    graphRunId: input.graphRunId,
    requestNodeRunId: firstBlocked?.id,
  });
  if (!elected.elected) {
    if (elected.reason === 'max-replans-exhausted') {
      emitGraphDiagnostic({ db, debug: deps.debug }, {
        category: 'replan',
        graphRunId: input.graphRunId,
        detail: 'refused (config-then-resume): replan budget exhausted — config change + Resume',
      });
      return { kind: 'refused', reason: 'config-then-resume' };
    }
    // A raced election (not-running/draining) — the run is already moving.
    return { kind: 'no-op' };
  }

  // The election durably moved the run to `draining`: the recovery entered.
  const block = stageBlock(deps.store, input.ticketId, 'impl');
  if (block && block.kind === GRAPH_FAILED_BLOCKER) {
    clearStageBlock(deps.store, input.ticketId, 'impl');
  }

  // Step 7: allocate the replan planner run and produce its launch request,
  // once the drain quiesces. Deferred when the drain is still working or the
  // host has not wired the planner launch seams.
  if (deps.readPrompt && deps.writeSnapshot && deps.plannerPromptPath && deps.ticketContext !== undefined) {
    const launchDeps: ReplanLaunchDeps = {
      ...replanDeps,
      writeSnapshot: deps.writeSnapshot,
      readPrompt: deps.readPrompt,
      promptPath: deps.plannerPromptPath,
      ticketContext: deps.ticketContext,
    };
    const begun = beginReplanPlannerRun(launchDeps, { graphRunId: input.graphRunId });
    if (begun.ok) {
      emitGraphDiagnostic({ db, debug: deps.debug }, {
        category: 'replan',
        graphRunId: input.graphRunId,
        plannerRunId: begun.plannerRunId,
        detail: `elected — planner run ${begun.plannerRunId} (#${begun.plannerRunNumber})`,
      });
      return {
        kind: 'replanned',
        plannerRunId: begun.plannerRunId,
        plannerRunNumber: begun.plannerRunNumber,
        launch: begun.launch,
      };
    }
    emitGraphDiagnostic({ db, debug: deps.debug }, {
      category: 'replan',
      graphRunId: input.graphRunId,
      detail: `elected; planner deferred (${begun.reason})`,
    });
    return { kind: 'replanned', plannerRunId: null, plannerRunNumber: null, launch: null };
  }
  emitGraphDiagnostic({ db, debug: deps.debug }, {
    category: 'replan',
    graphRunId: input.graphRunId,
    detail: 'elected; planner launch seams unwired',
  });
  return { kind: 'replanned', plannerRunId: null, plannerRunNumber: null, launch: null };
}

/**
 * Claim and run graph recovery for one blocked run. Returns what happened;
 * `refused` names the category that must not retry itself.
 */
export function recoverGraphRun(
  deps: RecoveryDeps,
  input: { ticketId: number; graphRunId: number },
): RecoveryResult {
  const { store } = deps;
  const ticket = getTicket(store, input.ticketId);
  if (ticket.stageCurrent !== 'impl') return { kind: 'no-op' };

  const run = store.db
    .prepare('SELECT id, status, blocked_reason FROM approach_graph_runs WHERE id = ?')
    .get(input.graphRunId) as BlockedRunRow | undefined;
  if (!run || run.status !== 'blocked') return { kind: 'no-op' };

  const category = recoveryCategoryFor(run.blocked_reason);
  switch (category) {
    case 'launch-retry':
    case 'prompt-resnapshot':
      return retryReservedVisits(deps, input, category);
    case 'replan':
    case 'compile-new-revision':
      return replanRecovery(deps, input);
    case 'discard-required':
      emitGraphDiagnostic({ db: deps.store.db, debug: deps.debug }, {
        category: 'recovery',
        graphRunId: input.graphRunId,
        detail: `refused (discard-required): ${run.blocked_reason ?? 'unknown reason'} — discard the unknown process`,
      });
      return { kind: 'refused', reason: 'discard-required' };
    case 'config-then-resume':
      emitGraphDiagnostic({ db: deps.store.db, debug: deps.debug }, {
        category: 'recovery',
        graphRunId: input.graphRunId,
        detail: `refused (config-then-resume): ${run.blocked_reason ?? 'unknown reason'} — config change within hard caps, then Resume`,
      });
      return { kind: 'refused', reason: 'config-then-resume' };
    case 'explicit-resolution':
      emitGraphDiagnostic({ db: deps.store.db, debug: deps.debug }, {
        category: 'recovery',
        graphRunId: input.graphRunId,
        detail: `refused (explicit-resolution): ${run.blocked_reason ?? 'unknown reason'} — corrected artifacts/claims or replan, then explicit Resume`,
      });
      return { kind: 'refused', reason: 'explicit-resolution' };
  }
  const unreachable: never = category;
  throw new Error(`unhandled recovery category: ${String(unreachable)}`);
}
