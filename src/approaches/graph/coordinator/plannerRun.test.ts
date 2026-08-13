/**
 * Durable bootstrap PlannerRun lifecycle (Slice 2 Task 5).
 *
 * The graph run + bootstrap planner run are durable BEFORE any external
 * work; the prompt is snapshotted at run creation so an edit to the on-disk
 * prompt mid-run does not affect the active run; an unreadable override
 * blocks with `instructions-missing` and spends nothing; the planning →
 * awaiting-confirmation / running split follows `confirmGeneratedGraph`.
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../../../store/db.js';
import { graphRunById } from '../../../store/graph/graphRuns.js';
import { plannerRunById } from '../../../store/graph/plannerRuns.js';
import {
  beginBootstrapPlannerRun,
  finishPlanning,
  sha256Hex,
  type PlannerRunDeps,
} from './plannerRun.js';

function harness(): {
  db: ReturnType<typeof openStore>['db'];
  dir: string;
  ticketId: number;
  makeDeps: (overrides?: Partial<PlannerRunDeps>) => PlannerRunDeps;
} {
  const store = openStore(':memory:');
  const ticketId = Number(
    store.db.prepare("INSERT INTO tickets (key) VALUES ('T-1')").run().lastInsertRowid,
  );
  const dir = mkdtempSync(join(tmpdir(), 'karst-planner-run-'));
  const promptFile = join(dir, 'graph-planner.md');
  const snapshotRoot = join(dir, 'snapshots');
  const deps: PlannerRunDeps = {
    db: store.db,
    transaction: <T>(fn: () => T): T => store.db.transaction(fn)(),
    promptPath: promptFile,
    readPrompt: (path: string) => {
      try {
        return new Uint8Array(readFileSync(path));
      } catch {
        return undefined;
      }
    },
    writeSnapshot: (graphRunId: number, relativePath: string, bytes: Uint8Array) => {
      const target = join(snapshotRoot, String(graphRunId), relativePath);
      mkdirSync(join(target, '..'), { recursive: true });
      writeFileSync(target, bytes);
    },
    projectSlug: 'project',
    now: () => '2026-08-11T00:00:00.000Z',
  };
  return {
    db: store.db,
    dir,
    ticketId,
    makeDeps: (overrides) => ({ ...deps, ...overrides }),
  };
}

describe('beginBootstrapPlannerRun', () => {
  it('persists the graph run and bootstrap planner run before any launch', () => {
    const { db, dir, ticketId, makeDeps } = harness();
    writeFileSync(join(dir, 'graph-planner.md'), '# planner');
    const result = beginBootstrapPlannerRun(makeDeps(), { ticketId, stageAttempt: 0, approachId: 'karst-graph-engineering' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const graphRun = graphRunById(db, result.graphRunId);
    expect(graphRun).toMatchObject({
      ticket_id: ticketId,
      stage_attempt: 0,
      approach_id: 'karst-graph-engineering',
      status: 'planning',
    });
    const plannerRun = plannerRunById(db, result.plannerRunId);
    expect(plannerRun).toMatchObject({
      graph_run_id: result.graphRunId,
      planner_run_number: 1,
      kind: 'bootstrap',
      status: 'ready',
      prompt_hash: result.promptHash,
      artifact_snapshot_id: result.promptSnapshotPath,
    });
    // The bootstrap planner is not a node in its own graph.
    const nodeRuns = db.prepare('SELECT COUNT(*) AS n FROM approach_node_runs').get() as {
      n: number;
    };
    expect(nodeRuns.n).toBe(0);
    expect(result.promptHash).toBe(sha256Hex(new TextEncoder().encode('# planner')));
  });

  it('snapshots the prompt bytes at run creation; a mid-run edit does not affect the run', () => {
    const { db, dir, ticketId, makeDeps } = harness();
    writeFileSync(join(dir, 'graph-planner.md'), 'version A');
    const first = beginBootstrapPlannerRun(makeDeps(), { ticketId, stageAttempt: 0, approachId: 'karst-graph-engineering' });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    writeFileSync(join(dir, 'graph-planner.md'), 'version B — a repo-wide writer edited the on-disk prompt');
    const plannerRun = plannerRunById(db, first.plannerRunId);
    expect(plannerRun!.prompt_hash).toBe(sha256Hex(new TextEncoder().encode('version A')));
    expect(plannerRun!.prompt_hash).not.toBe(sha256Hex(new TextEncoder().encode('version B')));
  });

  it('blocks with instructions-missing on an unreadable override and spends nothing', () => {
    const { db, dir, ticketId, makeDeps } = harness();
    writeFileSync(join(dir, 'graph-planner.md'), '# planner');
    const result = beginBootstrapPlannerRun(
      makeDeps({ readPrompt: () => undefined }),
      { ticketId, stageAttempt: 0, approachId: 'karst-graph-engineering' },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('instructions-missing');
    const graphRuns = db.prepare('SELECT COUNT(*) AS n FROM approach_graph_runs').get() as {
      n: number;
    };
    const plannerRuns = db.prepare('SELECT COUNT(*) AS n FROM approach_planner_runs').get() as {
      n: number;
    };
    expect(graphRuns.n).toBe(0);
    expect(plannerRuns.n).toBe(0);
  });

  it('rolls back the run creation when the snapshot write fails', () => {
    const { db, dir, ticketId, makeDeps } = harness();
    writeFileSync(join(dir, 'graph-planner.md'), '# planner');
    expect(() =>
      beginBootstrapPlannerRun(
        makeDeps({
          writeSnapshot: () => {
            throw new Error('disk full');
          },
        }),
        { ticketId, stageAttempt: 0, approachId: 'karst-graph-engineering' },
      ),
    ).toThrow('disk full');
    const graphRuns = db.prepare('SELECT COUNT(*) AS n FROM approach_graph_runs').get() as {
      n: number;
    };
    expect(graphRuns.n).toBe(0);
  });
});

describe('finishPlanning', () => {
  function begin(
    db: ReturnType<typeof openStore>['db'],
    dir: string,
    ticketId: number,
    makeDeps: (overrides?: Partial<PlannerRunDeps>) => PlannerRunDeps,
  ): number {
    writeFileSync(join(dir, 'graph-planner.md'), '# planner');
    const result = beginBootstrapPlannerRun(makeDeps(), { ticketId, stageAttempt: 0, approachId: 'karst-graph-engineering' });
    if (!result.ok) throw new Error('expected success');
    return result.graphRunId;
  }

  it('moves planning → awaiting-confirmation when confirmGeneratedGraph is true', () => {
    const { db, dir, ticketId, makeDeps } = harness();
    const graphRunId = begin(db, dir, ticketId, makeDeps);
    expect(finishPlanning(db, graphRunId, true)).toBe(true);
    expect(graphRunById(db, graphRunId)!.status).toBe('awaiting-confirmation');
  });

  it('moves planning → running when confirmGeneratedGraph is false', () => {
    const { db, dir, ticketId, makeDeps } = harness();
    const graphRunId = begin(db, dir, ticketId, makeDeps);
    expect(finishPlanning(db, graphRunId, false)).toBe(true);
    expect(graphRunById(db, graphRunId)!.status).toBe('running');
  });

  it('is a no-op for a run that already left planning', () => {
    const { db, dir, ticketId, makeDeps } = harness();
    const graphRunId = begin(db, dir, ticketId, makeDeps);
    finishPlanning(db, graphRunId, false);
    expect(finishPlanning(db, graphRunId, true)).toBe(false);
    expect(graphRunById(db, graphRunId)!.status).toBe('running');
  });
});
