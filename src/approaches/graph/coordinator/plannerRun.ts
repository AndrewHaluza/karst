/**
 * Durable bootstrap PlannerRun lifecycle (Slice 2 Task 5).
 *
 * Creating a graph run for (ticket, project, impl attempt) and its durable
 * bootstrap PlannerRun happens BEFORE any external work, in one transaction.
 * The bootstrap planner is not a node in the graph it generates. Initial
 * planning and replanning share one planner-run protocol with distinct
 * immutable run identities (monotonic planner-run numbers per graph run).
 *
 * Prompt snapshots (Decision 14): the effective prompt bytes — packaged
 * overlaid with the project override — are snapshotted into content-addressed
 * storage at planner-run creation, and the recorded SHA-256 is stored on the
 * run. The launch reads only the snapshot and verifies the recorded hash; an
 * override that fails to read at run creation blocks with
 * `instructions-missing` BEFORE any spend. Edits to the on-disk prompt take
 * effect on the next run, never on a retry of an existing one.
 *
 * Host-agnostic: the db, transaction, prompt read, and snapshot write are
 * injected; no vscode, no provider, no stage machine.
 */

import { createHash } from 'node:crypto';
import type { GraphDb } from '../../../store/graph/transitions.js';
import { createGraphRun, graphRunById, transitionGraphRun } from '../../../store/graph/graphRuns.js';
import {
  createPlannerRun,
  nextPlannerRunNumber,
  plannerRunById,
  transitionPlannerRun,
} from '../../../store/graph/plannerRuns.js';

export interface PlannerRunDeps {
  db: GraphDb;
  /** BEGIN IMMEDIATE-wrapped, all-or-nothing; a throw rolls back. */
  transaction: <T>(fn: () => T) => T;
  /** Effective prompt path, packaged overlaid with the project override. */
  promptPath: string;
  /** Returns the prompt bytes, or undefined when the file cannot be read. */
  readPrompt: (path: string) => Uint8Array | undefined;
  /** Content-addressed write under the graph run's snapshot root. */
  writeSnapshot: (graphRunId: number, relativePath: string, bytes: Uint8Array) => void;
  projectSlug: string;
  now: () => string;
}

export interface BeginBootstrapInput {
  ticketId: number;
  stageAttempt: number;
  approachId: string;
}

export type BeginBootstrapResult =
  | {
      ok: true;
      graphRunId: number;
      plannerRunId: number;
      promptHash: string;
      promptSnapshotPath: string;
    }
  | { ok: false; code: 'instructions-missing'; reason: string };

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Create the graph run and the durable bootstrap planner run in one
 * transaction, snapshoting the effective prompt bytes first. An unreadable
 * override blocks with `instructions-missing` and creates nothing — no
 * planner run, no graph run, no spend.
 */
export function beginBootstrapPlannerRun(
  deps: PlannerRunDeps,
  input: BeginBootstrapInput,
): BeginBootstrapResult {
  const promptBytes = deps.readPrompt(deps.promptPath);
  if (promptBytes === undefined) {
    return {
      ok: false,
      code: 'instructions-missing',
      reason: `cannot read the graph planner prompt at "${deps.promptPath}"`,
    };
  }
  const promptHash = sha256Hex(promptBytes);
  const now = deps.now();

  let graphRunId = 0;
  let plannerRunId = 0;
  let promptSnapshotPath = '';
  deps.transaction(() => {
    graphRunId = createGraphRun(deps.db, {
      ticketId: input.ticketId,
      stageAttempt: input.stageAttempt,
      approachId: input.approachId,
      now,
    });
    plannerRunId = createPlannerRun(deps.db, {
      graphRunId,
      plannerRunNumber: 1,
      kind: 'bootstrap',
    });
    deps.db
      .prepare(
        `UPDATE approach_planner_runs
         SET prompt_hash = ?, artifact_snapshot_id = ?
         WHERE id = ?`,
      )
      .run(promptHash, `prompts/${promptHash}`, plannerRunId);
    // Content-addressed snapshot write is part of the same all-or-nothing
    // unit: a throw here rolls the run creation back.
    promptSnapshotPath = `prompts/${promptHash}`;
    deps.writeSnapshot(graphRunId, promptSnapshotPath, promptBytes);
  });

  return { ok: true, graphRunId, plannerRunId, promptHash, promptSnapshotPath };
}

export interface BeginBootstrapRelaunchInput {
  graphRunId: number;
}

export type BeginBootstrapRelaunchResult =
  | {
      ok: true;
      plannerRunId: number;
      plannerRunNumber: number;
      promptHash: string;
      promptSnapshotPath: string;
    }
  | { ok: false; code: 'not-found' | 'not-planning' | 'instructions-missing'; reason: string };

/**
 * Relaunch a planning run's bootstrap planner (the reconcile crash matrix's
 * response to a demonstrably-dead planner session): allocate a NEW bootstrap
 * planner run on the EXISTING graph run — never a second graph run — and
 * snapshot the effective prompt, mirroring `beginBootstrapPlannerRun` minus
 * the graph-run creation. A run that left `planning` is never relaunched (the
 * relaunched planner's submission would be refused by the run's accept path),
 * and an unreadable prompt blocks with `instructions-missing` and creates
 * nothing — no planner run, no spend.
 */
export function relaunchBootstrapPlannerRun(
  deps: PlannerRunDeps,
  input: BeginBootstrapRelaunchInput,
): BeginBootstrapRelaunchResult {
  const run = graphRunById(deps.db, input.graphRunId);
  if (!run) return { ok: false, code: 'not-found', reason: `graph run ${input.graphRunId} not found` };
  if (run.status !== 'planning') {
    return {
      ok: false,
      code: 'not-planning',
      reason: `graph run ${input.graphRunId} is ${run.status}, not planning`,
    };
  }
  const promptBytes = deps.readPrompt(deps.promptPath);
  if (promptBytes === undefined) {
    return {
      ok: false,
      code: 'instructions-missing',
      reason: `cannot read the graph planner prompt at "${deps.promptPath}"`,
    };
  }
  const promptHash = sha256Hex(promptBytes);
  const now = deps.now();

  let plannerRunId = 0;
  let plannerRunNumber = 0;
  let promptSnapshotPath = '';
  deps.transaction(() => {
    plannerRunNumber = nextPlannerRunNumber(deps.db, input.graphRunId);
    plannerRunId = createPlannerRun(deps.db, {
      graphRunId: input.graphRunId,
      plannerRunNumber,
      kind: 'bootstrap',
    });
    deps.db
      .prepare(
        `UPDATE approach_planner_runs
         SET prompt_hash = ?, artifact_snapshot_id = ?
         WHERE id = ?`,
      )
      .run(promptHash, `prompts/${promptHash}`, plannerRunId);
    // Content-addressed snapshot write is part of the same all-or-nothing
    // unit: a throw here rolls the run creation back.
    promptSnapshotPath = `prompts/${promptHash}`;
    deps.writeSnapshot(input.graphRunId, promptSnapshotPath, promptBytes);
  });

  return { ok: true, plannerRunId, plannerRunNumber, promptHash, promptSnapshotPath };
}

/**
 * The planning → awaiting-confirmation / running split: taken when the
 * compiled graph is accepted. `confirmGeneratedGraph` is the packaged
 * default (true) read from the graph configuration.
 */
export function finishPlanning(
  db: GraphDb,
  graphRunId: number,
  confirmGeneratedGraph: boolean,
): boolean {
  const run = graphRunById(db, graphRunId);
  if (!run || run.status !== 'planning') return false;
  return transitionGraphRun(
    db,
    graphRunId,
    'planning',
    confirmGeneratedGraph ? 'awaiting-confirmation' : 'running',
  );
}

/**
 * Allocate the next monotonic planner-run identity for a graph run, mirroring
 * the bootstrap protocol's distinct immutable run identities (the replan
 * election in Slice 4 uses this; the prompt snapshot at replan-run creation
 * follows the same path as `beginBootstrapPlannerRun`).
 */
export function nextPlannerIdentity(
  db: GraphDb,
  graphRunId: number,
): { plannerRunId: number; plannerRunNumber: number } | undefined {
  const run = graphRunById(db, graphRunId);
  if (!run) return undefined;
  const plannerRunNumber = nextPlannerRunNumber(db, graphRunId);
  const plannerRunId = createPlannerRun(db, {
    graphRunId,
    plannerRunNumber,
    kind: 'replan',
  });
  return { plannerRunId, plannerRunNumber };
}

export {
  graphRunById,
  plannerRunById,
  transitionGraphRun,
  transitionPlannerRun,
};
