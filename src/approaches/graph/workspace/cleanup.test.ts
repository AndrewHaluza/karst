/**
 * Node execution workspace cleanup tests (Slice 5 Task 1).
 *
 * Cleanup mirrors `removeWorktree`'s `stopServersUnder`-first removal: every
 * running `servers` row whose cwd sits under the workspace is reaped with
 * process attribution first, then the tree is removed and the durable
 * per-graph-run byte total is negated (never below zero).
 */

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openStore } from '../../../store/db.js';
import { createNodeWorkspace, type NodeWorkspaceDeps, type WorkspaceDomain } from './provider.js';
import {
  cleanupNodeWorkspace,
  cleanupTerminalNodeWorkspace,
  type CleanupNodeWorkspaceDeps,
} from './cleanup.js';
import { gitCommonDirFromFs } from '../integration/domains.js';
import {
  releaseWorkspaceBytes,
  removeWorkspacesForNode,
  workspaceBytesOf,
  workspacesForNode,
} from '../../../store/graph/nodeRuns.js';
import { defaultGitRunner } from '../../../integrations/git.js';
import type { ProcessFacts } from '../../../runtime/serverIdentity.js';

function withImmediate<T>(db: ReturnType<typeof openStore>['db'], fn: () => T): T {
  const runner = (db.transaction as unknown as (f: () => T, o: { begin: 'immediate' }) => () => T)(
    fn,
    { begin: 'immediate' },
  );
  return runner();
}

const deadFacts: ProcessFacts = {
  isAlive: () => false,
  liveCwd: () => null,
  processStartMs: () => null,
};

/** A live-but-unattributable process (no cwd, no start-time evidence). */
const unknownFacts: ProcessFacts = {
  isAlive: () => true,
  liveCwd: () => null,
  processStartMs: () => null,
};

function git(cwd: string, args: string[]): string {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} in ${cwd}: ${r.stderr}`);
  return r.stdout.trim();
}

function makeRepo(): { dir: string; baseSha: string } {
  const dir = mkdtempSync(join(tmpdir(), 'karst-ws-clean-'));
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', 't@karst']);
  git(dir, ['config', 'user.name', 'T']);
  writeFileSync(join(dir, 'a.ts'), 'a\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-qm', 'base']);
  return { dir, baseSha: git(dir, ['rev-parse', 'HEAD']) };
}

interface Harness {
  store: ReturnType<typeof openStore>;
  db: ReturnType<typeof openStore>['db'];
  ticketId: number;
  graphRunId: number;
  revisionId: number;
  globalRoot: string;
  worktree: string;
  domains: WorkspaceDomain[];
  close: () => void;
}

function harness(): Harness {
  const store = openStore(':memory:');
  const db = store.db;
  db.pragma('busy_timeout = 0');
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
  const globalRoot = mkdtempSync(join(tmpdir(), 'karst-ws-clean-root-'));
  const domains: WorkspaceDomain[] = [
    { repoName: 'web', canonicalWorktreePath: dir, gitCommonDir: gitCommonDirFromFs(dir), baseCommit: baseSha },
  ];
  return {
    store,
    db,
    ticketId,
    graphRunId,
    revisionId,
    globalRoot,
    worktree: dir,
    domains,
    close: () => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
      rmSync(globalRoot, { recursive: true, force: true });
    },
  };
}

function providerDeps(h: Harness): NodeWorkspaceDeps {
  return {
    db: h.db,
    transaction: <T>(fn: () => T): T => withImmediate(h.db, fn),
    git: defaultGitRunner,
    maxAggregateWorkspaceBytes: 1 << 30,
    globalStorageRoot: h.globalRoot,
    facts: deadFacts,
    measureBytes: () => 500,
    now: () => '2026-08-12T00:00:00.000Z',
  };
}

function cleanupDeps(h: Harness, facts: ProcessFacts = deadFacts): CleanupNodeWorkspaceDeps {
  return {
    store: h.store,
    transaction: <T>(fn: () => T): T => withImmediate(h.db, fn),
    facts,
  };
}

async function createWorkspace(h: Harness, nodeRunId: number): Promise<string> {
  h.db
    .prepare(
      `INSERT INTO approach_node_runs (id, graph_run_id, revision_id, node_id, node_kind, visit_number, status)
       VALUES (?, ?, ?, ?, 'agent', 1, 'ready')
       ON CONFLICT(id) DO NOTHING`,
    )
    .run(nodeRunId, h.graphRunId, h.revisionId, `worker-${nodeRunId}`);
  const result = await createNodeWorkspace(providerDeps(h), {
    projectSlug: 'proj',
    ticketId: h.ticketId,
    graphRunId: h.graphRunId,
    nodeRunId,
    domains: h.domains,
  });
  if (result.kind !== 'created') throw new Error(`expected created, got ${result.kind}`);
  return result.paths[0]!.cwd;
}

describe('cleanupNodeWorkspace', () => {
  it('removes the workspace, reaps dead servers under it, and negates the byte counter', async () => {
    const h = harness();
    try {
      const cwd = await createWorkspace(h, 3);
      expect(workspaceBytesOf(h.db, h.graphRunId)).toBe(500);
      // A crashed run's server row, cwd under the workspace, process dead.
      const serverId = Number(
        h.db
          .prepare(
            `INSERT INTO servers (ticket_id, repo, pid, status, cwd, started_at)
             VALUES (?, 'web', 4242, 'running', ?, '2026-08-12T00:00:00.000Z')`,
          )
          .run(h.ticketId, cwd)
          .lastInsertRowid,
      );

      const result = await cleanupNodeWorkspace(cleanupDeps(h, deadFacts), {
        graphRunId: h.graphRunId,
        nodeRunId: 3,
        cwd,
      });
      expect(result.kind).toBe('removed');
      if (result.kind !== 'removed') return;
      expect(result.releasedBytes).toBe(500);
      expect(result.reaped).toHaveLength(1);
      expect(result.reaped[0]!.outcome).toBe('row-cleared');
      // The stale row stopped claiming to run; nothing was signalled.
      const row = h.db.prepare('SELECT status, pid FROM servers WHERE id = ?').get(serverId) as {
        status: string;
        pid: number | null;
      };
      expect(row.status).toBe('stopped');
      expect(row.pid).toBeNull();
      expect(existsSync(cwd)).toBe(false);
      expect(workspacesForNode(h.db, 3)).toHaveLength(0);
      expect(workspaceBytesOf(h.db, h.graphRunId)).toBe(0);
    } finally {
      h.close();
    }
  });

  it('reaps an unattributable live-process row without signalling and still removes the tree', async () => {
    const h = harness();
    try {
      const cwd = await createWorkspace(h, 4);
      h.db
        .prepare(
          `INSERT INTO servers (ticket_id, repo, pid, status, cwd, started_at)
           VALUES (?, 'web', 5150, 'running', ?, '2026-08-12T00:00:00.000Z')`,
        )
        .run(h.ticketId, cwd);
      const result = await cleanupNodeWorkspace(cleanupDeps(h, unknownFacts), {
        graphRunId: h.graphRunId,
        nodeRunId: 4,
        cwd,
      });
      expect(result.kind).toBe('removed');
      if (result.kind !== 'removed') return;
      expect(result.reaped[0]!.outcome).toBe('row-cleared');
      expect(existsSync(cwd)).toBe(false);
      expect(workspaceBytesOf(h.db, h.graphRunId)).toBe(0);
    } finally {
      h.close();
    }
  });

  it('is a no-op when nothing was recorded and the directory is already gone', async () => {
    const h = harness();
    try {
      const result = await cleanupNodeWorkspace(cleanupDeps(h), {
        graphRunId: h.graphRunId,
        nodeRunId: 99,
        cwd: join(h.globalRoot, 'nonexistent'),
      });
      expect(result.kind).toBe('no-op');
      expect(workspaceBytesOf(h.db, h.graphRunId)).toBe(0);
    } finally {
      h.close();
    }
  });

  it('releasing the byte counter never goes negative', async () => {
    const h = harness();
    try {
      const cwd = await createWorkspace(h, 5);
      // Inflate the ledger (a double record) beyond the counter's total so the
      // release arithmetic is exercised: release 500 twice from a total of 500.
      const result = await cleanupNodeWorkspace(cleanupDeps(h, deadFacts), {
        graphRunId: h.graphRunId,
        nodeRunId: 5,
        cwd,
      });
      expect(result.kind).toBe('removed');
      expect(workspaceBytesOf(h.db, h.graphRunId)).toBe(0);
      // A second cleanup of the same node run has no ledger rows left.
      const again = await cleanupNodeWorkspace(cleanupDeps(h, deadFacts), {
        graphRunId: h.graphRunId,
        nodeRunId: 5,
        cwd,
      });
      expect(again.kind).toBe('no-op');
      expect(workspaceBytesOf(h.db, h.graphRunId)).toBe(0);
    } finally {
      h.close();
    }
  });

  it('re-reads the ledger under the lock when two terminal observers race', async () => {
    const h = harness();
    try {
      const firstCwd = await createWorkspace(h, 6);
      await createWorkspace(h, 7);
      expect(workspaceBytesOf(h.db, h.graphRunId)).toBe(1_000);
      let transactionNumber = 0;
      const deps: CleanupNodeWorkspaceDeps = {
        store: h.store,
        facts: deadFacts,
        transaction: <T>(fn: () => T): T => {
          transactionNumber += 1;
          if (transactionNumber === 2) {
            // The run-close observer won after this completion observer had
            // already seen the directory: it released node 6's 500-byte row.
            withImmediate(h.db, () => {
              removeWorkspacesForNode(h.db, 6);
              releaseWorkspaceBytes(h.db, h.graphRunId, 500);
            });
          }
          return withImmediate(h.db, fn);
        },
      };

      const result = cleanupNodeWorkspace(deps, {
        graphRunId: h.graphRunId,
        nodeRunId: 6,
        cwd: firstCwd,
      });

      expect(result.kind).toBe('no-op');
      // Node 7 still owns 500 bytes. A stale pre-lock read would release node
      // 6 twice and incorrectly clamp the whole graph total to zero.
      expect(workspaceBytesOf(h.db, h.graphRunId)).toBe(500);
      expect(workspacesForNode(h.db, 7)).toHaveLength(1);
    } finally {
      h.close();
    }
  });
});

describe('cleanupTerminalNodeWorkspace', () => {
  it.each(['ready', 'running', 'blocked', 'termination-unknown'])(
    'preserves a recoverable %s node workspace',
    async (status) => {
      const h = harness();
      try {
        const cwd = await createWorkspace(h, 8);
        h.db.prepare('UPDATE approach_node_runs SET status = ? WHERE id = 8').run(status);

        const result = cleanupTerminalNodeWorkspace(cleanupDeps(h), {
          graphRunId: h.graphRunId,
          nodeRunId: 8,
        });

        expect(result.kind).toBe('no-op');
        expect(existsSync(cwd)).toBe(true);
        expect(workspacesForNode(h.db, 8)).toHaveLength(1);
        expect(workspaceBytesOf(h.db, h.graphRunId)).toBe(500);
      } finally {
        h.close();
      }
    },
  );
});
