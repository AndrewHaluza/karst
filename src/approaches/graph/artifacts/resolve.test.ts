/**
 * Causal artifact binding (Slice 4 Task 2).
 *
 * Every production records an immutable ArtifactInstance; inputs resolve to
 * the NEWEST SUCCESSFUL instance in the activation's causal lineage (the
 * fork-lineage stack of its claimed token; planner-produced artifacts are
 * roots); a same-id instance outside the lineage is never selected; an
 * ambiguous or missing binding blocks, never a global "latest". Required
 * output validation snapshots the produced files and refuses an effective
 * `complete` when a required output is missing or unsafe.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../../../store/db.js';
import {
  recordArtifactInstance,
  resolveInput,
  validateRequiredOutputs,
  type RecordArtifactInstanceInput,
} from './resolve.js';

const DOC = {
  version: 1,
  title: 't',
  rationaleArtifact: 'r',
  entries: ['fix'],
  artifacts: [
    {
      id: 'report',
      path: 'reports/out.md',
      producer: 'fix',
      consumers: ['verify'],
      mediaType: 'text/markdown',
      maxBytes: 4096,
      required: true,
    },
    {
      id: 'extra',
      path: 'reports/extra.json',
      producer: 'fix',
      consumers: [],
      mediaType: 'application/json',
      maxBytes: 4096,
      required: false,
    },
  ],
  nodes: [
    {
      id: 'fix',
      kind: 'agent',
      label: 'fix',
      profile: 'default',
      instructionsArtifact: 'i',
      inputs: [],
      outputs: ['report', 'extra'],
      resources: { reads: [], writes: [] },
      outcomes: ['complete', 'blocked'],
      budget: { maxVisits: 3 },
    },
    {
      id: 'verify',
      kind: 'agent',
      label: 'verify',
      profile: 'default',
      instructionsArtifact: 'i',
      inputs: ['report'],
      outputs: [],
      resources: { reads: [], writes: [] },
      outcomes: ['complete'],
      budget: { maxVisits: 1 },
    },
  ],
  edges: [
    { id: 'e1', from: 'fix', on: 'complete', to: 'verify' },
    { id: 'e2', from: 'verify', on: 'complete', to: 'END' },
  ],
  budgets: { maxNodeRuns: 10, maxExpertRuns: 1, maxReplans: 1 },
};

interface Ctx {
  db: ReturnType<typeof openStore>['db'];
  graphRunId: number;
  revisionId: number;
  ticketId: number;
  close: () => void;
}

function harness(): Ctx {
  const store = openStore(':memory:');
  const db = store.db;
  const ticketId = Number(db.prepare("INSERT INTO tickets (key) VALUES ('T-1')").run().lastInsertRowid);
  const graphRunId = Number(
    db
      .prepare(
        `INSERT INTO approach_graph_runs (ticket_id, stage_key, stage_attempt, approach_id, status, created_at)
         VALUES (?, 'impl', 0, 'x', 'running', '2026-08-12T00:00:00.000Z')`,
      )
      .run(ticketId)
      .lastInsertRowid,
  );
  const revisionId = Number(
    db
      .prepare(
        `INSERT INTO approach_graph_revisions
           (graph_run_id, revision_number, canonical_graph, fingerprint, status, created_at)
         VALUES (?, 1, ?, 'fp', 'active', '2026-08-12T00:00:00.000Z')`,
      )
      .run(graphRunId, JSON.stringify(DOC))
      .lastInsertRowid,
  );
  return { db, graphRunId, revisionId, ticketId, close: () => store.close() };
}

function nodeRun(ctx: Ctx, id: number, nodeId: string, visitNumber: number): void {
  ctx.db
    .prepare(
      `INSERT INTO approach_node_runs
         (id, graph_run_id, revision_id, node_id, node_kind, visit_number, status)
       VALUES (?, ?, ?, ?, 'agent', ?, 'completed')`,
    )
    .run(id, ctx.graphRunId, ctx.revisionId, nodeId, visitNumber);
}

function record(
  ctx: Ctx,
  overrides: Partial<RecordArtifactInstanceInput> & { producerNodeRunId?: number; producerPlannerRunId?: number },
): number {
  return recordArtifactInstance(ctx.db, {
    graphRunId: ctx.graphRunId,
    revisionId: ctx.revisionId,
    artifactId: 'report',
    producerPlannerRunId: null,
    producerNodeRunId: null,
    forkLineage: 'root',
    snapshotPath: '/snap/x',
    sha256: 'a'.repeat(64),
    mediaType: 'text/markdown',
    byteSize: 1,
    sensitivity: null,
    now: '2026-08-12T00:00:00.000Z',
    ...overrides,
  });
}

function resolve(ctx: Ctx, lineage: string | null, nodeId = 'verify') {
  return resolveInput(ctx.db, {
    revisionId: ctx.revisionId,
    nodeId,
    activationTokens: [{ fork_lineage: lineage }],
  });
}

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

describe('recordArtifactInstance', () => {
  it('writes an immutable instance keyed by revision, producer run and lineage', () => {
    const ctx = harness();
    cleanups.push(ctx.close);
    nodeRun(ctx, 1, 'fix', 1);
    const id = record(ctx, { producerNodeRunId: 1, forkLineage: 'root' });
    const row = ctx.db
      .prepare('SELECT * FROM approach_artifact_instances WHERE id = ?')
      .get(id) as { artifact_id: string; revision_id: number; producer_node_run_id: number; fork_lineage: string; sha256: string };
    expect(row.artifact_id).toBe('report');
    expect(row.revision_id).toBe(ctx.revisionId);
    expect(row.producer_node_run_id).toBe(1);
    expect(row.fork_lineage).toBe('root');
    expect(row.sha256).toHaveLength(64);
  });
});

describe('resolveInput — causal lineage binding', () => {
  it('two loop visits produce two instances and the consumer binds the causal one', () => {
    const ctx = harness();
    cleanups.push(ctx.close);
    nodeRun(ctx, 1, 'fix', 1);
    nodeRun(ctx, 2, 'fix', 2);
    nodeRun(ctx, 3, 'fix', 3);
    record(ctx, { producerNodeRunId: 1, forkLineage: 'root' });
    record(ctx, { producerNodeRunId: 2, forkLineage: 'root:fix' });
    record(ctx, { producerNodeRunId: 3, forkLineage: 'root:fix:fix' });

    // verify is activated by fix's third loop visit (lineage 'root:fix:fix').
    const result = resolve(ctx, 'root:fix:fix');
    expect(result.kind).toBe('bound');
    if (result.kind !== 'bound') return;
    expect(result.instances).toHaveLength(1);
    expect(result.instances[0]!.producer_node_run_id).toBe(3);
    expect(result.instances[0]!.fork_lineage).toBe('root:fix:fix');
  });

  it('a same-id instance outside the lineage is never selected', () => {
    const ctx = harness();
    cleanups.push(ctx.close);
    nodeRun(ctx, 1, 'fix', 1);
    nodeRun(ctx, 2, 'fix', 2);
    record(ctx, { producerNodeRunId: 1, forkLineage: 'root' });
    record(ctx, { producerNodeRunId: 2, forkLineage: 'root:fix' });
    // A sibling-branch production of the SAME logical id, newest by rowid.
    record(ctx, { producerNodeRunId: 9, forkLineage: 'root:other' });
    // A production in another revision entirely.
    record(ctx, { producerNodeRunId: 10, forkLineage: 'root', revisionId: ctx.revisionId + 1 });

    // A 'root:fix' consumer binds its own visit's instance, not the
    // globally-newest sibling ('root:other') and not the other revision's.
    const deep = resolve(ctx, 'root:fix');
    expect(deep.kind).toBe('bound');
    if (deep.kind !== 'bound') return;
    expect(deep.instances[0]!.producer_node_run_id).toBe(2);

    // A 'root' consumer binds the first visit — never a global "latest".
    const shallow = resolve(ctx, 'root');
    expect(shallow.kind).toBe('bound');
    if (shallow.kind !== 'bound') return;
    expect(shallow.instances[0]!.producer_node_run_id).toBe(1);
  });

  it('an ambiguous binding blocks; it never selects a global latest', () => {
    const ctx = harness();
    cleanups.push(ctx.close);
    nodeRun(ctx, 1, 'fix', 1);
    nodeRun(ctx, 2, 'fix', 2);
    // Two sibling productions on the SAME lineage from DIFFERENT producer
    // runs: neither is causally after the other, so no binding is valid.
    record(ctx, { producerNodeRunId: 1, forkLineage: 'root' });
    record(ctx, { producerNodeRunId: 2, forkLineage: 'root' });

    const result = resolve(ctx, 'root');
    expect(result.kind).toBe('ambiguous');
    if (result.kind !== 'ambiguous') return;
    expect(result.artifactId).toBe('report');
    expect(result.candidates).toBe(2);
  });

  it('a missing binding reports missing', () => {
    const ctx = harness();
    cleanups.push(ctx.close);
    const result = resolve(ctx, 'root');
    expect(result).toEqual({ kind: 'missing', artifactId: 'report' });
  });

  it('planner-produced artifacts are roots in every lineage', () => {
    const ctx = harness();
    cleanups.push(ctx.close);
    record(ctx, { producerPlannerRunId: 5, forkLineage: null, revisionId: ctx.revisionId });
    const result = resolve(ctx, 'root:fix:fix');
    expect(result.kind).toBe('bound');
    if (result.kind !== 'bound') return;
    expect(result.instances[0]!.producer_planner_run_id).toBe(5);
  });

  it('a node with no declared inputs binds nothing', () => {
    const ctx = harness();
    cleanups.push(ctx.close);
    const result = resolve(ctx, 'root', 'fix');
    expect(result).toEqual({ kind: 'bound', instances: [] });
  });
});

describe('validateRequiredOutputs', () => {
  function outCtx(): { ctx: Ctx; root: string } {
    const ctx = harness();
    const root = mkdtempSync(join(tmpdir(), 'karst-artifacts-'));
    cleanups.push(ctx.close);
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    return { ctx, root };
  }

  function validate(ctx: Ctx, root: string, nodeId = 'fix', nodeRunId = 1) {
    return validateRequiredOutputs(ctx.db, {
      revisionId: ctx.revisionId,
      nodeId,
      nodeRunId,
      outputPaths: {
        report: join(root, 'reports/out.md'),
        extra: join(root, 'reports/extra.json'),
      },
      snapshotDir: root,
    });
  }

  it('accepts a complete set of required outputs and returns snapshot instances', () => {
    const { ctx, root } = outCtx();
    mkdirSync(join(root, 'reports'), { recursive: true });
    writeFileSync(join(root, 'reports/out.md'), '# report');
    writeFileSync(join(root, 'reports/extra.json'), '{"ok":true}');
    nodeRun(ctx, 1, 'fix', 1);
    ctx.db
      .prepare(
        `INSERT INTO approach_graph_tokens
           (revision_id, source_node_run_id, is_entry, edge_id, destination_node_id,
            destination_end, fork_instance, fork_lineage, status, created_at)
         VALUES (?, NULL, 1, 'e1', 'fix', 0, 0, 'root:fix', 'claimed', ?)`,
      )
      .run(ctx.revisionId, '2026-08-12T00:00:00.000Z');
    ctx.db
      .prepare('UPDATE approach_graph_tokens SET claiming_node_run_id = 1 WHERE id = last_insert_rowid()')
      .run();

    const result = validate(ctx, root);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.instances).toHaveLength(2);
    const report = result.instances.find((i) => i.artifactId === 'report')!;
    expect(report.sha256).toHaveLength(64);
    expect(report.mediaType).toBe('text/markdown');
    expect(report.byteSize).toBe('# report'.length);
    // The content-addressed copy landed under the snapshot dir.
    expect(join(root, report.sha256)).toBe(report.snapshotPath);
    // The activation lineage is carried out for instance recording.
    expect(result.forkLineage).toBe('root:fix');
  });

  it('a missing required output is output-artifact-missing', () => {
    const { ctx, root } = outCtx();
    const result = validate(ctx, root);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('output-artifact-missing');
    expect(result.artifactId).toBe('report');
  });

  it('an oversize required output is artifact-unsafe', () => {
    const { ctx, root } = outCtx();
    mkdirSync(join(root, 'reports'), { recursive: true });
    writeFileSync(join(root, 'reports/out.md'), 'x'.repeat(8192));
    const result = validate(ctx, root);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('artifact-unsafe');
    expect(result.artifactId).toBe('report');
  });

  it('a media-mismatched required output is artifact-unsafe', () => {
    const { ctx, root } = outCtx();
    mkdirSync(join(root, 'reports'), { recursive: true });
    writeFileSync(join(root, 'reports/out.md'), Buffer.from([0x23, 0x00, 0x42]));
    const result = validate(ctx, root);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('artifact-unsafe');
    expect(result.artifactId).toBe('report');
  });

  it('a missing NON-required output does not block', () => {
    const { ctx, root } = outCtx();
    mkdirSync(join(root, 'reports'), { recursive: true });
    writeFileSync(join(root, 'reports/out.md'), '# report');
    const result = validate(ctx, root);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.instances).toHaveLength(1);
    expect(result.instances[0]!.artifactId).toBe('report');
  });

  it('a node with no declared outputs validates trivially', () => {
    const { ctx, root } = outCtx();
    const result = validateRequiredOutputs(ctx.db, {
      revisionId: ctx.revisionId,
      nodeId: 'verify',
      nodeRunId: 1,
      outputPaths: {},
      snapshotDir: root,
    });
    expect(result).toEqual({ ok: true, instances: [], forkLineage: null });
  });
});
