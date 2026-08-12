/**
 * Completion-pipeline tests (Slice 3 Task 8).
 *
 * The completing node's change set is captured per physical domain, compared
 * against declared writes BEFORE any integration, and integrated serially in
 * deterministic node-run order under a durable exclusive lock (no other node
 * of the graph may be completing/integrating). Real git repos in temp dirs
 * provide the diff/commit machinery; the transport and session registry are
 * fakes.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, chmodSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openStore } from '../../../store/db.js';
import { runCompletionPipeline, INTEGRATION_COMMIT_PREFIX, type CompletionPipelineDeps } from './pipeline.js';
import { domainKeyOf } from './domains.js';
import { canonicalPath } from '../../../runtime/pathScope.js';
import { acquireLease } from '../../../store/graph/leases.js';
import type { AgentTransport, SupervisedAgentSession } from '../transport/supervisedCliTransport.js';
import type { GitRunner } from '../../../integrations/git.js';

interface Harness {
  db: ReturnType<typeof openStore>['db'];
  graphRunId: number;
  revisionId: number;
  ticketId: number;
  worktree: string;
  baseSha: string;
  artifactRoot: string;
  close: () => void;
}

function git(cwd: string, args: string[]): string {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} in ${cwd}: ${r.stderr}`);
  return r.stdout.trim();
}

/** A real git repo at `base` with `a.ts`; worktree points at `base`. */
function makeRepo(): { dir: string; baseSha: string } {
  const dir = mkdtempSync(join(tmpdir(), 'karst-graph-int-'));
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', 't@karst']);
  git(dir, ['config', 'user.name', 'T']);
  writeFileSync(join(dir, 'a.ts'), 'a\n');
  writeFileSync(join(dir, 'b.ts'), 'b\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-qm', 'base']);
  return { dir, baseSha: git(dir, ['rev-parse', 'HEAD']) };
}

function harness(): Harness {
  const store = openStore(':memory:');
  const db = store.db;
  const ticketId = Number(db.prepare("INSERT INTO tickets (key) VALUES ('T-1')").run().lastInsertRowid);
  const graphRunId = Number(
    db
      .prepare(
        `INSERT INTO approach_graph_runs (ticket_id, stage_key, stage_attempt, approach_id, status, created_at)
         VALUES (?, 'impl', 0, 'karst-graph-engineering', 'running', '2026-08-12T00:00:00.000Z')`,
      )
      .run(ticketId)
      .lastInsertRowid,
  );
  const revisionId = Number(
    db
      .prepare(
        `INSERT INTO approach_graph_revisions
           (graph_run_id, revision_number, canonical_graph, fingerprint, status, created_at)
         VALUES (?, 1, '{}', 'fp', 'active', '2026-08-12T00:00:00.000Z')`,
      )
      .run(graphRunId)
      .lastInsertRowid,
  );
  const { dir, baseSha } = makeRepo();
  const artifactRoot = mkdtempSync(join(tmpdir(), 'karst-artifacts-'));
  return {
    db,
    graphRunId,
    revisionId,
    ticketId,
    worktree: dir,
    baseSha,
    artifactRoot,
    close: () => {
      store.close();
      rmSync(artifactRoot, { recursive: true, force: true });
    },
  };
}

function insertNodeRun(h: Harness, id: number, status: string): void {
  h.db
    .prepare(
      `INSERT INTO approach_node_runs
         (id, graph_run_id, revision_id, node_id, node_kind, visit_number, status)
       VALUES (?, ?, ?, 'n', 'agent', ?, ?)`,
    )
    .run(id, h.graphRunId, h.revisionId, id, status);
}

function lease(h: Harness, nodeRunId: number, physicalDomain: string): void {
  acquireLease(h.db, {
    graphRunId: h.graphRunId,
    ownerNodeRunId: nodeRunId,
    physicalDomain,
    accessMode: 'write',
    claimedPaths: null,
    now: '2026-08-12T00:00:00.000Z',
  });
}

function leaseRow(h: Harness, nodeRunId: number): { status: string } {
  return h.db
    .prepare('SELECT status FROM approach_resource_leases WHERE owner_node_run_id = ?')
    .get(nodeRunId) as { status: string };
}

function session(nodeRunId: number): SupervisedAgentSession {
  return { nodeRunId, ticketId: 1, graphRunId: 1, pid: 4200 + nodeRunId, cwd: '/wt' } as SupervisedAgentSession;
}

function makeDeps(
  h: Harness,
  overrides: Partial<CompletionPipelineDeps> = {},
): CompletionPipelineDeps {
  const base: CompletionPipelineDeps = {
    db: h.db,
    transaction: <T>(fn: () => T): T =>
      (h.db.transaction as unknown as (f: () => T, o: { begin: 'immediate' }) => () => T)(fn, {
        begin: 'immediate',
      })(),
    now: () => '2026-08-12T00:00:00.000Z',
    git: (args, cwd) => {
      const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
      return Promise.resolve({ stdout: r.stdout.trim(), stderr: r.stderr, exitCode: r.status ?? -1 });
    },
    gitCommonDirOf: (cwd) => git(cwd, ['rev-parse', '--git-common-dir']),
    transport: {
      capabilities: () => ({ exactModel: false, attributedTermination: true }),
      start: async () => {
        throw new Error('unused');
      },
      terminate: async () => ({ kind: 'attributable', kill: 'killed' }),
    },
    getSession: (nodeRunId) => session(nodeRunId),
    domainsFor: () => [{ repoName: 'api', worktreePath: h.worktree }],
    artifactRoot: () => h.artifactRoot,
    declaredWritesOf: () => [
      {
        domainKey: domainKeyOf(canonicalPath(h.worktree), gitCommonDirOf2(h.worktree)),
        paths: ['a.ts'],
      },
    ],
  };
  return { ...base, ...overrides };
}

function gitCommonDirOf2(cwd: string): string | null {
  return git(cwd, ['rev-parse', '--git-common-dir']);
}

const cleanups: (() => void)[] = [];
beforeEach(() => cleanups.length = 0);
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function nodeRow(h: Harness, id: number): { status: string; failure_category: string | null; change_set_id: string | null } {
  return h.db
    .prepare(
      'SELECT status, failure_category, change_set_id FROM approach_node_runs WHERE id = ?',
    )
    .get(id) as never;
}

describe('runCompletionPipeline — claim validation', () => {
  it('an out-of-claim file blocks with resource-claim-violated BEFORE integration', async () => {
    const h = harness();
    cleanups.push(h.close);
    insertNodeRun(h, 11, 'completing');
    lease(h, 11, 'dom-blocked');
    writeFileSync(join(h.worktree, 'a.ts'), 'a2\n');
    writeFileSync(join(h.worktree, 'b.ts'), 'b2\n'); // outside the declared writes
    const logBefore = git(h.worktree, ['log', '--format=%H', '-1']);

    const result = await runCompletionPipeline(
      makeDeps(h),
      { graphRunId: h.graphRunId, nodeRunId: 11 },
    );
    expect(result.kind).toBe('claim-violated');
    if (result.kind === 'claim-violated') {
      expect(result.violations).toEqual(['b.ts']);
    }
    expect(nodeRow(h, 11)).toMatchObject({
      status: 'blocked',
      failure_category: 'resource-claim-violated',
    });
    const run = h.db.prepare('SELECT status, blocked_reason FROM approach_graph_runs WHERE id = ?').get(h.graphRunId) as {
      status: string;
      blocked_reason: string;
    };
    expect(run.status).toBe('blocked');
    expect(run.blocked_reason).toContain('resource-claim-violated');
    // Nothing was integrated: no new commit, both trees preserved.
    expect(git(h.worktree, ['log', '--format=%H', '-1'])).toBe(logBefore);
    expect(readFileSync(join(h.worktree, 'b.ts'), 'utf8')).toBe('b2\n');
    // The lease stays HELD — preserved behind the blocker (Slice 5 T2): only
    // the discard action or the resumed integration releases it.
    expect(leaseRow(h, 11)).toEqual({ status: 'held' });
  });

  it('a node with no declared writes and a dirty worktree violates every path', async () => {
    const h = harness();
    cleanups.push(h.close);
    insertNodeRun(h, 12, 'completing');
    writeFileSync(join(h.worktree, 'a.ts'), 'x\n');
    const result = await runCompletionPipeline(
      makeDeps(h, { declaredWritesOf: () => [] }),
      { graphRunId: h.graphRunId, nodeRunId: 12 },
    );
    expect(result.kind).toBe('claim-violated');
  });
});

describe('runCompletionPipeline — integration', () => {
  it('integrates a valid change set and completes the node, leaving the graph running', async () => {
    const h = harness();
    cleanups.push(h.close);
    insertNodeRun(h, 21, 'completing');
    writeFileSync(join(h.worktree, 'a.ts'), 'a3\n');

    const result = await runCompletionPipeline(
      makeDeps(h),
      { graphRunId: h.graphRunId, nodeRunId: 21 },
    );
    expect(result).toEqual({ kind: 'integrated', committed: true });
    expect(nodeRow(h, 21)).toMatchObject({
      status: 'completed',
      change_set_id: `cs:${h.graphRunId}:21`,
    });
    const run = h.db.prepare('SELECT status FROM approach_graph_runs WHERE id = ?').get(h.graphRunId) as {
      status: string;
    };
    expect(run.status).toBe('running');
    // The change set was committed under the integration marker.
    const log = git(h.worktree, ['log', '--format=%s', '-1']);
    expect(log).toBe(`${INTEGRATION_COMMIT_PREFIX} ${h.graphRunId} node 21`);
    expect(readFileSync(join(h.worktree, 'a.ts'), 'utf8')).toBe('a3\n');
  });

  it('a node with no changes integrates nothing and still completes', async () => {
    const h = harness();
    cleanups.push(h.close);
    insertNodeRun(h, 22, 'completing');
    const result = await runCompletionPipeline(
      makeDeps(h),
      { graphRunId: h.graphRunId, nodeRunId: 22 },
    );
    expect(result).toEqual({ kind: 'integrated', committed: false });
    expect(nodeRow(h, 22).status).toBe('completed');
  });

  it('a successful integration releases the node held leases in the same transaction (Slice 5 T2)', async () => {
    const h = harness();
    cleanups.push(h.close);
    insertNodeRun(h, 24, 'completing');
    lease(h, 24, 'dom-a');
    lease(h, 24, 'dom-b');
    writeFileSync(join(h.worktree, 'a.ts'), 'a5\n');
    const result = await runCompletionPipeline(
      makeDeps(h),
      { graphRunId: h.graphRunId, nodeRunId: 24 },
    );
    expect(result).toEqual({ kind: 'integrated', committed: true });
    expect(nodeRow(h, 24).status).toBe('completed');
    const rows = h.db
      .prepare('SELECT status FROM approach_resource_leases WHERE owner_node_run_id = 24 ORDER BY physical_domain')
      .all() as { status: string }[];
    expect(rows).toEqual([{ status: 'released' }, { status: 'released' }]);
  });

  it('a git refusal to land the change set preserves both trees and blocks with integration-conflict', async () => {
    const h = harness();
    cleanups.push(h.close);
    insertNodeRun(h, 23, 'completing');
    // A failing pre-commit hook makes git refuse the integration commit: the
    // change set could not be landed, and BOTH trees stay as they are.
    const hookPath = join(h.worktree, '.git/hooks/pre-commit');
    writeFileSync(hookPath, '#!/bin/sh\nexit 1\n');
    chmodSync(hookPath, 0o755);
    writeFileSync(join(h.worktree, 'a.ts'), 'a4\n');
    const logBefore = git(h.worktree, ['log', '--format=%H', '-1']);

    const result = await runCompletionPipeline(
      makeDeps(h),
      { graphRunId: h.graphRunId, nodeRunId: 23 },
    );
    expect(result.kind).toBe('integration-conflict');
    expect(nodeRow(h, 23)).toMatchObject({
      status: 'blocked',
      failure_category: 'integration-conflict',
    });
    const run = h.db.prepare('SELECT status, blocked_reason FROM approach_graph_runs WHERE id = ?').get(h.graphRunId) as {
      status: string;
      blocked_reason: string;
    };
    expect(run.status).toBe('blocked');
    expect(run.blocked_reason).toContain('integration-conflict');
    // Preserved: HEAD untouched, node's change still in the worktree.
    expect(git(h.worktree, ['log', '--format=%H', '-1'])).toBe(logBefore);
    expect(git(h.worktree, ['status', '--porcelain'])).toContain('a.ts');
  });
});

describe('runCompletionPipeline — serialization and order', () => {
  it('deferred while another node of the graph is integrating', async () => {
    const h = harness();
    cleanups.push(h.close);
    insertNodeRun(h, 31, 'completing');
    insertNodeRun(h, 32, 'integrating');
    const result = await runCompletionPipeline(
      makeDeps(h),
      { graphRunId: h.graphRunId, nodeRunId: 31 },
    );
    expect(result.kind).toBe('deferred');
    expect(nodeRow(h, 31).status).toBe('completing');
  });

  it('two completing nodes integrate one at a time in node-run order', async () => {
    const h = harness();
    cleanups.push(h.close);
    insertNodeRun(h, 41, 'completing');
    insertNodeRun(h, 42, 'completing');
    writeFileSync(join(h.worktree, 'a.ts'), 'one\n');

    // The caller processes completing nodes in ascending node-run order; the
    // atomic integrating-slot CAS serializes the write phases.
    const first = await runCompletionPipeline(makeDeps(h), { graphRunId: h.graphRunId, nodeRunId: 41 });
    expect(first.kind).toBe('integrated');
    // Node 42's own change lands after node 41's integration.
    writeFileSync(join(h.worktree, 'a.ts'), 'two\n');
    const second = await runCompletionPipeline(makeDeps(h), { graphRunId: h.graphRunId, nodeRunId: 42 });
    expect(second.kind).toBe('integrated');
    expect(nodeRow(h, 41).status).toBe('completed');
    expect(nodeRow(h, 42).status).toBe('completed');
    const log = git(h.worktree, ['log', '--format=%s', '-2']).split('\n');
    expect(log[0]).toBe(`${INTEGRATION_COMMIT_PREFIX} ${h.graphRunId} node 42`);
    expect(log[1]).toBe(`${INTEGRATION_COMMIT_PREFIX} ${h.graphRunId} node 41`);
  });

  it('two repository entries sharing one repoPath serialize onto one worktree', async () => {
    const h = harness();
    cleanups.push(h.close);
    insertNodeRun(h, 51, 'completing');
    insertNodeRun(h, 52, 'completing');
    writeFileSync(join(h.worktree, 'a.ts'), 'shared\n');
    const deps = makeDeps(h, {
      domainsFor: () => [
        { repoName: 'api', worktreePath: h.worktree },
        { repoName: 'web', worktreePath: h.worktree },
      ],
    });
    const first = await runCompletionPipeline(deps, { graphRunId: h.graphRunId, nodeRunId: 51 });
    expect(first.kind).toBe('integrated');
    writeFileSync(join(h.worktree, 'a.ts'), 'shared2\n');
    const second = await runCompletionPipeline(deps, { graphRunId: h.graphRunId, nodeRunId: 52 });
    expect(second.kind).toBe('integrated');
    // Exactly one integration commit per node, all on the one worktree.
    const log = git(h.worktree, ['log', '--format=%s']).split('\n');
    expect(log.filter((m) => m.startsWith(INTEGRATION_COMMIT_PREFIX))).toHaveLength(2);
  });
});

describe('runCompletionPipeline — termination', () => {
  it('unproven termination parks the node at termination-unknown and never integrates', async () => {
    const h = harness();
    cleanups.push(h.close);
    insertNodeRun(h, 61, 'completing');
    lease(h, 61, 'dom-term');
    writeFileSync(join(h.worktree, 'a.ts'), 'z\n');
    const logBefore = git(h.worktree, ['log', '--format=%H', '-1']);
    const result = await runCompletionPipeline(
      makeDeps(h, {
        transport: {
          capabilities: () => ({ exactModel: false, attributedTermination: true }),
          start: async () => {
            throw new Error('unused');
          },
          terminate: async () => ({ kind: 'attributable', kill: 'denied' }),
        },
      }),
      { graphRunId: h.graphRunId, nodeRunId: 61 },
    );
    expect(result.kind).toBe('termination-unknown');
    expect(nodeRow(h, 61).status).toBe('termination-unknown');
    const run = h.db.prepare('SELECT status FROM approach_graph_runs WHERE id = ?').get(h.graphRunId) as {
      status: string;
    };
    expect(run.status).toBe('running');
    expect(git(h.worktree, ['log', '--format=%H', '-1'])).toBe(logBefore);
    // Termination unproven: the lease stays HELD (never released while
    // termination is unknown; the reconcile pass marks it ambiguous later).
    expect(leaseRow(h, 61)).toEqual({ status: 'held' });
  });

  it('a session that vanished from the registry cannot prove termination', async () => {
    const h = harness();
    cleanups.push(h.close);
    insertNodeRun(h, 62, 'completing');
    const result = await runCompletionPipeline(
      makeDeps(h, { getSession: () => undefined }),
      { graphRunId: h.graphRunId, nodeRunId: 62 },
    );
    expect(result.kind).toBe('termination-unknown');
  });
});

describe('runCompletionPipeline — guards', () => {
  it('no-op when the node is not completing', async () => {
    const h = harness();
    cleanups.push(h.close);
    insertNodeRun(h, 71, 'completed');
    const result = await runCompletionPipeline(
      makeDeps(h),
      { graphRunId: h.graphRunId, nodeRunId: 71 },
    );
    expect(result.kind).toBe('no-op');
  });

  it('no-op when the graph run is not running', async () => {
    const h = harness();
    cleanups.push(h.close);
    h.db.prepare('UPDATE approach_graph_runs SET status = ? WHERE id = ?').run('blocked', h.graphRunId);
    insertNodeRun(h, 72, 'completing');
    const result = await runCompletionPipeline(
      makeDeps(h),
      { graphRunId: h.graphRunId, nodeRunId: 72 },
    );
    expect(result.kind).toBe('no-op');
    expect(nodeRow(h, 72).status).toBe('completing');
  });
});

/**
 * Slice 4 Task 2 fixtures: a canonical document whose agent node `n` declares
 * one required output artifact (`spec`), and a claimed activation token whose
 * fork lineage is the producing activation's.
 */
const PIPELINE_DOC = {
  version: 1,
  title: 't',
  rationaleArtifact: 'r',
  entries: ['n'],
  artifacts: [
    {
      id: 'spec',
      path: 'out/spec.md',
      producer: 'n',
      consumers: [],
      mediaType: 'text/markdown',
      maxBytes: 4096,
      required: true,
    },
  ],
  nodes: [
    {
      id: 'n',
      kind: 'agent',
      label: 'n',
      profile: 'default',
      instructionsArtifact: 'i',
      inputs: [],
      outputs: ['spec'],
      resources: { reads: [], writes: [] },
      outcomes: ['complete'],
      budget: { maxVisits: 1 },
    },
  ],
  edges: [{ id: 'e-end', from: 'n', on: 'complete', to: 'END' }],
  budgets: { maxNodeRuns: 10, maxExpertRuns: 1, maxReplans: 1 },
};

function installDocument(h: Harness, doc: unknown): void {
  h.db
    .prepare('UPDATE approach_graph_revisions SET canonical_graph = ? WHERE id = ?')
    .run(JSON.stringify(doc), h.revisionId);
}

function claimNodeToken(h: Harness, nodeRunId: number, lineage: string): void {
  const res = h.db
    .prepare(
      `INSERT INTO approach_graph_tokens
         (revision_id, source_node_run_id, is_entry, edge_id, destination_node_id,
          destination_end, fork_instance, fork_lineage, status, created_at)
       VALUES (?, NULL, 1, 'e-entry', 'n', 0, 0, ?, 'claimed', '2026-08-12T00:00:00.000Z')`,
    )
    .run(h.revisionId, lineage);
  h.db
    .prepare('UPDATE approach_graph_tokens SET claiming_node_run_id = ? WHERE id = ?')
    .run(nodeRunId, Number(res.lastInsertRowid));
}

describe('runCompletionPipeline — required output validation (Slice-4 T2)', () => {
  it('a missing required output parks at output-artifact-missing: effective outcome null, no edge', async () => {
    const h = harness();
    cleanups.push(h.close);
    installDocument(h, PIPELINE_DOC);
    insertNodeRun(h, 81, 'completing');
    claimNodeToken(h, 81, 'root');

    const result = await runCompletionPipeline(
      makeDeps(h),
      { graphRunId: h.graphRunId, nodeRunId: 81 },
    );
    expect(result).toMatchObject({ kind: 'output-artifact-missing', artifactId: 'spec' });
    const node = h.db
      .prepare(
        'SELECT status, outcome, effective_outcome, failure_category FROM approach_node_runs WHERE id = 81',
      )
      .get() as { status: string; outcome: string | null; effective_outcome: string | null; failure_category: string | null };
    // The agent-authored `complete` stays immutable reported evidence…
    expect(node.outcome).toBe('complete');
    // …but the effective outcome is NULL and no edge is emitted.
    expect(node.status).toBe('output-artifact-missing');
    expect(node.effective_outcome).toBeNull();
    expect(node.failure_category).toBe('output-artifact-missing');
    const run = h.db
      .prepare('SELECT status, blocked_reason FROM approach_graph_runs WHERE id = ?')
      .get(h.graphRunId) as { status: string; blocked_reason: string | null };
    expect(run.status).toBe('blocked');
    expect(run.blocked_reason).toContain('output-artifact-missing');
    // No edge: the claimed token is never consumed and no successor exists.
    const claimed = h.db
      .prepare('SELECT status, destination_end FROM approach_graph_tokens WHERE claiming_node_run_id = 81')
      .all() as { status: string; destination_end: number }[];
    expect(claimed).toEqual([{ status: 'claimed', destination_end: 0 }]);
    const ends = h.db
      .prepare('SELECT COUNT(*) AS n FROM approach_graph_tokens WHERE destination_end = 1')
      .get() as { n: number };
    expect(ends.n).toBe(0);
    // A parked node records no instance: only completed productions do.
    const instances = h.db
      .prepare('SELECT COUNT(*) AS n FROM approach_artifact_instances')
      .get() as { n: number };
    expect(instances.n).toBe(0);
  });

  it('an unsafe required output parks at artifact-unsafe with effective outcome null', async () => {
    const h = harness();
    cleanups.push(h.close);
    installDocument(h, PIPELINE_DOC);
    insertNodeRun(h, 82, 'completing');
    claimNodeToken(h, 82, 'root');
    // The file exists but its bytes do not match the declared media type.
    mkdirSync(join(h.artifactRoot, 'out'), { recursive: true });
    writeFileSync(join(h.artifactRoot, 'out/spec.md'), Buffer.from([0x23, 0x00, 0x42]));

    const result = await runCompletionPipeline(
      makeDeps(h),
      { graphRunId: h.graphRunId, nodeRunId: 82 },
    );
    expect(result).toMatchObject({ kind: 'artifact-unsafe', artifactId: 'spec' });
    const node = h.db
      .prepare('SELECT status, effective_outcome FROM approach_node_runs WHERE id = 82')
      .get() as { status: string; effective_outcome: string | null };
    expect(node.status).toBe('artifact-unsafe');
    expect(node.effective_outcome).toBeNull();
    const run = h.db
      .prepare('SELECT status FROM approach_graph_runs WHERE id = ?')
      .get(h.graphRunId) as { status: string };
    expect(run.status).toBe('blocked');
    expect(
      h.db.prepare('SELECT COUNT(*) AS n FROM approach_artifact_instances').get() as { n: number },
    ).toEqual({ n: 0 });
  });

  it('a complete with all required outputs present records instances and emits the edge', async () => {
    const h = harness();
    cleanups.push(h.close);
    installDocument(h, PIPELINE_DOC);
    insertNodeRun(h, 83, 'completing');
    claimNodeToken(h, 83, 'root');
    const content = '# spec';
    mkdirSync(join(h.artifactRoot, 'out'), { recursive: true });
    writeFileSync(join(h.artifactRoot, 'out/spec.md'), content);

    const result = await runCompletionPipeline(
      makeDeps(h),
      { graphRunId: h.graphRunId, nodeRunId: 83 },
    );
    expect(result).toEqual({ kind: 'integrated', committed: false });
    const node = h.db
      .prepare('SELECT status, effective_outcome FROM approach_node_runs WHERE id = 83')
      .get() as { status: string; effective_outcome: string | null };
    expect(node.status).toBe('completed');
    expect(node.effective_outcome).toBe('complete');
    // The production was recorded as an instance in this run's lineage.
    const inst = h.db
      .prepare(
        `SELECT artifact_id, producer_node_run_id, fork_lineage, media_type, byte_size, snapshot_path, sha256
         FROM approach_artifact_instances`,
      )
      .get() as {
      artifact_id: string;
      producer_node_run_id: number;
      fork_lineage: string;
      media_type: string;
      byte_size: number;
      snapshot_path: string;
      sha256: string;
    };
    expect(inst.artifact_id).toBe('spec');
    expect(inst.producer_node_run_id).toBe(83);
    expect(inst.fork_lineage).toBe('root');
    expect(inst.media_type).toBe('text/markdown');
    expect(inst.byte_size).toBe(content.length);
    expect(inst.sha256).toBe(createHash('sha256').update(content).digest('hex'));
    expect(inst.snapshot_path).toBe(join(h.artifactRoot, inst.sha256));
    // The edge WAS emitted: the claim is consumed and the END token landed.
    const claimed = h.db
      .prepare('SELECT status FROM approach_graph_tokens WHERE claiming_node_run_id = 83')
      .all() as { status: string }[];
    expect(claimed).toEqual([{ status: 'consumed' }]);
    const ends = h.db
      .prepare('SELECT COUNT(*) AS n FROM approach_graph_tokens WHERE destination_end = 1')
      .get() as { n: number };
    expect(ends.n).toBe(1);
    const run = h.db
      .prepare('SELECT status FROM approach_graph_runs WHERE id = ?')
      .get(h.graphRunId) as { status: string };
    expect(run.status).toBe('running');
  });
});
