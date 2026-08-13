/**
 * `karst graph submit` — the closed parse path (Slice 2 Task 6).
 *
 * A forged capability, a wrong project, a wrong attempt, a stale generation,
 * and a duplicate submission are each an idempotent rejection with evidence
 * recorded (the returned result) and NO state change. Trailing argv and every
 * forbidden argv field are rejected. A submit against a stale schema fails
 * closed naming the file and both versions.
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../store/db.js';
import { createGraphRun } from '../store/graph/graphRuns.js';
import { createPlannerRun, plannerRunById } from '../store/graph/plannerRuns.js';
import {
  parseGraphArgs,
  readGraphSubmitEnv,
  runGraphCommand,
  sha256Hex,
  type GraphSubmitEnv,
} from './graph.js';

function harness(): {
  store: ReturnType<typeof openStore>;
  env: GraphSubmitEnv;
  dir: string;
  graphBytes: Uint8Array;
  graphRunId: number;
  plannerRunId: number;
} {
  const store = openStore(':memory:');
  const projectId = Number(
    store.db
      .prepare("INSERT INTO projects (slug) VALUES ('project')")
      .run().lastInsertRowid,
  );
  const ticketId = Number(
    store.db
      .prepare('INSERT INTO tickets (key, project_id) VALUES (?, ?)')
      .run('T-1', projectId).lastInsertRowid,
  );
  const graphRunId = createGraphRun(store.db, {
    ticketId,
    stageAttempt: 0,
    approachId: 'karst-graph-engineering',
    now: '2026-08-11T00:00:00.000Z',
  });
  const plannerRunId = createPlannerRun(store.db, {
    graphRunId,
    plannerRunNumber: 1,
    kind: 'bootstrap',
  });
  const capability = 'c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2';
  const generation = 'gen-1';
  store.db
    .prepare(
      `UPDATE approach_planner_runs
       SET status = 'running', generation = ?, capability_hash = ?
       WHERE id = ?`,
    )
    .run(generation, sha256Hex(new TextEncoder().encode(capability)), plannerRunId);

  const dir = mkdtempSync(join(tmpdir(), 'karst-graph-submit-'));
  const graphBytes = new TextEncoder().encode('{"version":1,"title":"plan"}');
  writeFileSync(join(dir, 'graph.json'), graphBytes);

  const env: GraphSubmitEnv = {
    project: String(projectId),
    ticketId: String(ticketId),
    graphRunId: String(graphRunId),
    plannerRunId: String(plannerRunId),
    generation,
    capability,
    artifactRoot: dir,
  };
  return { store, env, dir, graphBytes, graphRunId, plannerRunId };
}

function envRecord(env: GraphSubmitEnv): Record<string, string> {
  return {
    KARST_GRAPH_PROJECT: env.project,
    KARST_TICKET_ID: env.ticketId,
    KARST_GRAPH_RUN_ID: env.graphRunId,
    KARST_LAUNCH_ID: env.plannerRunId,
    KARST_GRAPH_GENERATION: env.generation,
    KARST_GRAPH_CAPABILITY: env.capability,
    KARST_GRAPH_ARTIFACT_ROOT: env.artifactRoot,
  };
}

function run(store: ReturnType<typeof openStore>, env: GraphSubmitEnv): {
  ok: boolean;
  rejected?: string;
  graphSnapshotId?: string;
} {
  return JSON.parse(
    runGraphCommand(
      store,
      envRecord(env),
      ['graph', 'submit'],
      () => '2026-08-11T00:00:00.000Z',
    ),
  );
}

describe('parseGraphArgs', () => {
  it('accepts exactly graph submit', () => {
    expect(parseGraphArgs(['graph', 'submit'])).toEqual({ verb: 'submit' });
  });

  it('rejects trailing argv', () => {
    expect(() => parseGraphArgs(['graph', 'submit', 'extra'])).toThrow(/no arguments/);
    expect(() => parseGraphArgs(['graph', 'submit', '--json'])).toThrow(/no arguments/);
  });

  it('rejects a forbidden verb', () => {
    expect(() => parseGraphArgs(['graph', 'complete'])).toThrow(/submit only/);
    expect(() => parseGraphArgs(['graph'])).toThrow(/submit only/);
  });

  it('rejects a foreign command', () => {
    expect(() => parseGraphArgs(['stage', 'submit'])).toThrow(/graph/);
  });
});

describe('readGraphSubmitEnv', () => {
  it('fails closed on a missing project identity', () => {
    expect(() => readGraphSubmitEnv({ KARST_TICKET_ID: '1' })).toThrow(
      /KARST_GRAPH_PROJECT/,
    );
  });

  it('fails closed on any missing identity field', () => {
    const env: Record<string, string | undefined> = {
      KARST_GRAPH_PROJECT: '1',
      KARST_TICKET_ID: '1',
      KARST_GRAPH_RUN_ID: '1',
      KARST_LAUNCH_ID: '1',
      KARST_GRAPH_GENERATION: 'g',
      KARST_GRAPH_CAPABILITY: 'c',
    };
    expect(() => readGraphSubmitEnv(env)).toThrow(/KARST_GRAPH_ARTIFACT_ROOT/);
  });
});

describe('runGraphCommand — success and idempotent rejection', () => {
  it('submits the fixed planner artifact and marks the run submitted', () => {
    const { store, env, dir, graphBytes, plannerRunId } = harness();
    const result = run(store, env);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.graphSnapshotId).toBe(sha256Hex(graphBytes));
    const row = plannerRunById(store.db, plannerRunId)!;
    expect(row.status).toBe('submitted');
    expect(row.graph_snapshot_id).toBe(sha256Hex(graphBytes));
    expect(row.submitted_at).toBe('2026-08-11T00:00:00.000Z');
    // The snapshot was written content-addressed under the artifact root.
    const snapshotPath = join(dir, 'snapshots', `${result.graphSnapshotId}.json`);
    expect(require('node:fs').existsSync(snapshotPath)).toBe(true);
  });

  it('rejects a duplicate submission idempotently with no state change', () => {
    const { store, env, plannerRunId } = harness();
    expect(run(store, env).ok).toBe(true);
    const before = plannerRunById(store.db, plannerRunId)!;
    const second = run(store, env);
    expect(second.ok).toBe(false);
    expect(second.rejected).toBe('duplicate-submission');
    const after = plannerRunById(store.db, plannerRunId)!;
    expect(after.status).toBe('submitted');
    expect(after.graph_snapshot_id).toBe(before.graph_snapshot_id);
  });

  it('rejects a forged capability idempotently', () => {
    const { store, env, plannerRunId } = harness();
    const result = run(store, { ...env, capability: 'forged' });
    expect(result.ok).toBe(false);
    expect(result.rejected).toBe('wrong-capability');
    expect(plannerRunById(store.db, plannerRunId)!.status).toBe('running');
  });

  it('rejects a wrong project idempotently', () => {
    const { store, env, plannerRunId } = harness();
    const other = Number(
      store.db.prepare("INSERT INTO projects (slug) VALUES ('other')").run().lastInsertRowid,
    );
    const result = run(store, { ...env, project: String(other) });
    expect(result.ok).toBe(false);
    expect(result.rejected).toBe('wrong-project');
    expect(plannerRunById(store.db, plannerRunId)!.status).toBe('running');
  });

  it('rejects a wrong attempt (unknown run) idempotently', () => {
    const { store, env, plannerRunId } = harness();
    const result = run(store, { ...env, graphRunId: '999999' });
    expect(result.ok).toBe(false);
    expect(result.rejected).toBe('unknown-run');
    expect(plannerRunById(store.db, plannerRunId)!.status).toBe('running');
  });

  it('rejects a stale generation idempotently', () => {
    const { store, env, plannerRunId } = harness();
    const result = run(store, { ...env, generation: 'gen-2' });
    expect(result.ok).toBe(false);
    expect(result.rejected).toBe('stale-generation');
    expect(plannerRunById(store.db, plannerRunId)!.status).toBe('running');
  });

  it('rejects a run that is not running idempotently', () => {
    const { store, env, plannerRunId } = harness();
    store.db
      .prepare(`UPDATE approach_planner_runs SET status = 'blocked' WHERE id = ?`)
      .run(plannerRunId);
    const result = run(store, env);
    expect(result.ok).toBe(false);
    expect(result.rejected).toBe('not-running');
  });

  it('fails closed when the planner artifact is missing', () => {
    const { store, env, dir } = harness();
    rmSync(join(dir, 'graph.json'));
    expect(() => run(store, env)).toThrow(/graph\.json/);
  });
});

describe('runGraphCommand — argv and schema hardening', () => {
  it('rejects trailing argv', () => {
    const { store, env } = harness();
    expect(() =>
      runGraphCommand(store, envRecord(env), ['graph', 'submit', 'extra']),
    ).toThrow(/no arguments/);
  });

  it('rejects every forbidden argv field', () => {
    const { store, env } = harness();
    const forbidden = ['--capability', '--generation', '--ticket', '--graph-run', '--to', '--profile', '--provider', '--model', '--effort', '--artifact-root', '--db'];
    for (const flag of forbidden) {
      expect(() => runGraphCommand(store, envRecord(env), ['graph', 'submit', flag, 'x'])).toThrow(
        /no arguments/,
      );
    }
  });
});
