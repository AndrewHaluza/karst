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
