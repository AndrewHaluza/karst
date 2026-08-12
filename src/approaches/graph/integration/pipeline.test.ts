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
import { mkdtempSync, rmSync, writeFileSync, readFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openStore } from '../../../store/db.js';
import { runCompletionPipeline, INTEGRATION_COMMIT_PREFIX, type CompletionPipelineDeps } from './pipeline.js';
import { domainKeyOf } from './domains.js';
import { canonicalPath } from '../../../runtime/pathScope.js';
import type { AgentTransport, SupervisedAgentSession } from '../transport/supervisedCliTransport.js';
import type { GitRunner } from '../../../integrations/git.js';

interface Harness {
  db: ReturnType<typeof openStore>['db'];
  graphRunId: number;
  revisionId: number;
  ticketId: number;
  worktree: string;
  baseSha: string;
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
  return { db, graphRunId, revisionId, ticketId, worktree: dir, baseSha, close: () => store.close() };
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
