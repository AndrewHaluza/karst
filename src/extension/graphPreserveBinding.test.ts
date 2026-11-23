import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, type Store } from '../store/db.js';
import type { GitRunner } from '../integrations/git.js';
import { graphPreserveSeams } from './graphPreserveBinding.js';

const NOW = '2026-11-01T00:00:00.000Z';
const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'karst-preserve-binding-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function graphStore(): { store: Store; graphRunId: number } {
  const store = openStore(':memory:');
  cleanups.push(() => store.close());
  const insert = (sql: string, ...args: unknown[]): number =>
    Number(store.db.prepare(sql).run(...args).lastInsertRowid);
  const projectId = insert("INSERT INTO projects (slug) VALUES ('p')");
  const ticketId = insert("INSERT INTO tickets (key, project_id) VALUES ('T-1', ?)", projectId);
  const graphRunId = insert(
    `INSERT INTO approach_graph_runs (ticket_id, stage_key, stage_attempt, approach_id, status, created_at)
     VALUES (?, 'impl', 0, 'karst-graph-engineering', 'draining', ?)`,
    ticketId,
    NOW,
  );
  insert(
    `INSERT INTO approach_graph_revisions
       (graph_run_id, revision_number, canonical_graph, fingerprint, status, created_at)
     VALUES (?, 1, '{}', 'fp', 'draining', ?)`,
    graphRunId,
    NOW,
  );
  return { store, graphRunId };
}

function nodeRun(store: Store, graphRunId: number, id: number, status: string, outcome: string | null): void {
  store.db
    .prepare(
      `INSERT INTO approach_node_runs
         (id, graph_run_id, revision_id, node_id, node_kind, visit_number, status, outcome)
       VALUES (?, ?, 1, ?, 'agent', ?, ?, ?)`,
    )
    .run(id, graphRunId, `n${id}`, id, status, outcome);
  store.db
    .prepare(
      `INSERT INTO approach_graph_workspaces (graph_run_id, node_run_id, repo_name, cwd, byte_size, created_at)
       VALUES (?, ?, 'api', ?, 1, ?)`,
    )
    .run(graphRunId, id, tempDir(), NOW);
}

const failingGit: GitRunner = async () => ({ stdout: '', stderr: 'not a repository', exitCode: 128 });

describe('graphPreserveSeams', () => {
  it('preserves only a blocked replan requester, logs a failure and continues', async () => {
    const { store, graphRunId } = graphStore();
    nodeRun(store, graphRunId, 1, 'blocked', 'replan');
    nodeRun(store, graphRunId, 2, 'blocked', 'blocked');
    nodeRun(store, graphRunId, 3, 'cancelled', 'replan');
    nodeRun(store, graphRunId, 4, 'blocked', 'replan');
    const logs: string[] = [];
    const root = tempDir();
    const seams = graphPreserveSeams(() => store.db, () => root, failingGit, (m) => logs.push(m));
    await seams.preserveReplanRequesters(graphRunId);
    const named = logs.flatMap((l) => /the work of node run (\d+) was not preserved/.exec(l)?.[1] ?? []);
    expect(named).toEqual(['1', '4']);
  });

  it('resolves the graph run of a node run, and reports a node run that is gone', async () => {
    const { store, graphRunId } = graphStore();
    nodeRun(store, graphRunId, 1, 'running', null);
    const roots: number[] = [];
    const seams = graphPreserveSeams(
      () => store.db,
      (id) => {
        roots.push(id);
        return tempDir();
      },
      failingGit,
    );
    expect((await seams.preserveNode(1)).kind).toBe('failed');
    expect(new Set(roots)).toEqual(new Set([graphRunId]));
    expect(await seams.preserveNode(99)).toEqual({ kind: 'nothing' });
  });

  it('fails without a store, so the provider keeps the clone', async () => {
    const seams = graphPreserveSeams(() => undefined, () => tempDir(), failingGit);
    expect((await seams.preserveWork({ graphRunId: 1, nodeRunId: 1 })).kind).toBe('failed');
  });

  it('lists the preserved work with a path relative to the artifact root', () => {
    const root = tempDir();
    mkdirSync(join(root, 'preserved', '7'), { recursive: true });
    writeFileSync(join(root, 'preserved', '7', 'api.patch'), 'diff');
    writeFileSync(join(root, 'preserved', '7', 'api.paths.json'), '["x.ts"]');
    const seams = graphPreserveSeams(() => undefined, () => root, failingGit);
    expect(seams.preservedWorkOf(1)).toEqual([
      { nodeRunId: 7, patchPath: 'preserved/7/api.patch', paths: ['x.ts'] },
    ]);
  });

  it('finds the clone of a node run by its repository name', () => {
    const { store, graphRunId } = graphStore();
    nodeRun(store, graphRunId, 1, 'running', null);
    const cwd = (store.db.prepare('SELECT cwd FROM approach_graph_workspaces').get() as { cwd: string }).cwd;
    const seams = graphPreserveSeams(() => store.db, () => '', failingGit);
    expect(seams.workspaceCwdOf(1, 'api')).toBe(cwd);
    expect(seams.workspaceCwdOf(1, 'web')).toBeUndefined();
  });
});
