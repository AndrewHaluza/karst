/**
 * Terminal workspace cleanup: the `includeStaleNodes` widening of T1342.
 *
 * Unit-level: temp directories + an in-memory store + fake process facts. No
 * git and no child process — the clone layout is created directly.
 */

import { describe, it, expect, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { openStore } from '../../../store/db.js';
import { nodeWorkspaceDir } from './provider.js';
import {
  cleanupTerminalGraphRunWorkspaces,
  cleanupTerminalNodeWorkspace,
  type CleanupNodeWorkspaceDeps,
} from './cleanup.js';
import { workspaceBytesOf } from '../../../store/graph/nodeRuns.js';
import type { ProcessFacts } from '../../../runtime/serverIdentity.js';

const { killTreeMock } = vi.hoisted(() => ({ killTreeMock: vi.fn() }));
vi.mock('../../../runtime/processTree.js', () => ({ killTree: killTreeMock }));

type Db = ReturnType<typeof openStore>['db'];

function withImmediate<T>(db: Db, fn: () => T): T {
  return db.transaction(fn).immediate();
}

const deadFacts: ProcessFacts = {
  isAlive: () => false,
  liveCwd: () => null,
  processStartMs: () => null,
};

interface Harness {
  store: ReturnType<typeof openStore>;
  db: Db;
  projectId: number;
  ticketId: number;
  graphRunId: number;
  revisionId: number;
  globalRoot: string;
  close: () => void;
}

function harness(graphRunStatus = 'cancelled'): Harness {
  const store = openStore(':memory:');
  const db = store.db;
  db.pragma('busy_timeout = 0');
  const projectId = Number(
    db.prepare("INSERT INTO projects (slug) VALUES ('proj')").run().lastInsertRowid,
  );
  const ticketId = Number(
    db
      .prepare("INSERT INTO tickets (key, project_id) VALUES ('T-1', ?)")
      .run(projectId).lastInsertRowid,
  );
  const graphRunId = Number(
    db
      .prepare(
        `INSERT INTO approach_graph_runs (ticket_id, stage_key, stage_attempt, approach_id, status, created_at)
         VALUES (?, 'impl', 0, 'karst-graph-engineering', ?, '2026-08-12T00:00:00.000Z')`,
      )
      .run(ticketId, graphRunStatus).lastInsertRowid,
  );
  const revisionId = Number(
    db
      .prepare(
        `INSERT INTO approach_graph_revisions
           (graph_run_id, revision_number, canonical_graph, fingerprint, status, created_at)
         VALUES (?, 1, '{}', 'fp', 'active', '2026-08-12T00:00:00.000Z')`,
      )
      .run(graphRunId).lastInsertRowid,
  );
  const globalRoot = mkdtempSync(join(tmpdir(), 'karst-ws-unit-'));
  return {
    store,
    db,
    projectId,
    ticketId,
    graphRunId,
    revisionId,
    globalRoot,
    close: () => {
      store.close();
      rmSync(globalRoot, { recursive: true, force: true });
    },
  };
}

function depsOf(h: Harness, facts: ProcessFacts = deadFacts): CleanupNodeWorkspaceDeps {
  return {
    store: h.store,
    transaction: <T>(fn: () => T): T => withImmediate(h.db, fn),
    facts,
  };
}

/** Create the authoritative workspace layout and its ledger for a node run. */
function addNode(h: Harness, nodeRunId: number, status: string, bytes: number): string {
  h.db
    .prepare(
      `INSERT INTO approach_node_runs (id, graph_run_id, revision_id, node_id, node_kind, visit_number, status)
       VALUES (?, ?, ?, ?, 'agent', 1, ?)`,
    )
    .run(nodeRunId, h.graphRunId, h.revisionId, `worker-${nodeRunId}`, status);
  const nodeDir = nodeWorkspaceDir(h.globalRoot, 'proj', h.ticketId, h.graphRunId, nodeRunId);
  const cwd = join(nodeDir, 'web');
  mkdirSync(cwd, { recursive: true });
  writeFileSync(join(cwd, 'index.ts'), 'export {}\n');
  h.db
    .prepare(
      `INSERT INTO approach_graph_workspaces (graph_run_id, node_run_id, repo_name, cwd, byte_size, created_at)
       VALUES (?, ?, 'web', ?, ?, '2026-08-12T00:00:00.000Z')`,
    )
    .run(h.graphRunId, nodeRunId, cwd, bytes);
  return nodeDir;
}

function setRunBytes(h: Harness, bytes: number): void {
  h.db
    .prepare('UPDATE approach_graph_runs SET workspace_bytes = ? WHERE id = ?')
    .run(bytes, h.graphRunId);
}

const removedIds = (results: Array<{ kind: string; nodeRunId: number }>): number[] =>
  results.filter((r) => r.kind === 'removed').map((r) => r.nodeRunId);

describe('cleanupTerminalGraphRunWorkspaces without includeStaleNodes', () => {
  it('keeps the stale, failed-to-launch and ready leftovers, and removes completed/cancelled', () => {
    const h = harness('cancelled');
    try {
      const completed = addNode(h, 1, 'completed', 100);
      const cancelled = addNode(h, 2, 'cancelled', 100);
      const stale = addNode(h, 3, 'stale', 100);
      const failedToLaunch = addNode(h, 4, 'failed-to-launch', 100);
      const ready = addNode(h, 5, 'ready', 100);
      setRunBytes(h, 500);

      const results = cleanupTerminalGraphRunWorkspaces(depsOf(h), { graphRunId: h.graphRunId });

      expect(removedIds(results)).toEqual([1, 2]);
      expect(existsSync(completed)).toBe(false);
      expect(existsSync(cancelled)).toBe(false);
      expect(existsSync(stale)).toBe(true);
      expect(existsSync(failedToLaunch)).toBe(true);
      expect(existsSync(ready)).toBe(true);
      expect(workspaceBytesOf(h.db, h.graphRunId)).toBe(300);
    } finally {
      h.close();
    }
  });
});

describe('cleanupTerminalGraphRunWorkspaces with includeStaleNodes', () => {
  it.each(['cancelled', 'closed'])(
    'removes every non-running node of a %s run and releases exactly their bytes',
    (runStatus) => {
      const h = harness(runStatus);
      try {
        const dirs = new Map([
          [1, addNode(h, 1, 'completed', 100)],
          [2, addNode(h, 2, 'cancelled', 100)],
          [3, addNode(h, 3, 'stale', 100)],
          [4, addNode(h, 4, 'failed-to-launch', 100)],
          [5, addNode(h, 5, 'ready', 100)],
        ]);
        setRunBytes(h, 500);

        const results = cleanupTerminalGraphRunWorkspaces(depsOf(h), {
          graphRunId: h.graphRunId,
          includeStaleNodes: true,
        });

        expect(removedIds(results)).toEqual([1, 2, 3, 4, 5]);
        for (const dir of dirs.values()) expect(existsSync(dir)).toBe(false);
        const released = results.reduce(
          (sum, r) => sum + (r.kind === 'removed' ? r.releasedBytes : 0),
          0,
        );
        expect(released).toBe(500);
        expect(workspaceBytesOf(h.db, h.graphRunId)).toBe(0);
      } finally {
        h.close();
      }
    },
  );

  it('clamps the run byte total at zero rather than going negative', () => {
    const h = harness('cancelled');
    try {
      addNode(h, 1, 'stale', 500);
      setRunBytes(h, 100);

      cleanupTerminalGraphRunWorkspaces(depsOf(h), {
        graphRunId: h.graphRunId,
        includeStaleNodes: true,
      });

      expect(workspaceBytesOf(h.db, h.graphRunId)).toBe(0);
    } finally {
      h.close();
    }
  });

  it('never removes a running node, even inside a terminal run', () => {
    const h = harness('cancelled');
    try {
      const running = addNode(h, 1, 'running', 100);
      const stale = addNode(h, 2, 'stale', 100);
      setRunBytes(h, 200);

      const results = cleanupTerminalGraphRunWorkspaces(depsOf(h), {
        graphRunId: h.graphRunId,
        includeStaleNodes: true,
      });

      expect(removedIds(results)).toEqual([2]);
      expect(existsSync(running)).toBe(true);
      expect(existsSync(stale)).toBe(false);
      expect(workspaceBytesOf(h.db, h.graphRunId)).toBe(100);
    } finally {
      h.close();
    }
  });

  it('keeps a LIVE run\'s stale and failed-to-launch nodes recoverable', () => {
    const h = harness('running');
    try {
      const stale = addNode(h, 1, 'stale', 100);
      const failedToLaunch = addNode(h, 2, 'failed-to-launch', 100);
      const ready = addNode(h, 3, 'ready', 100);
      setRunBytes(h, 300);

      const results = cleanupTerminalGraphRunWorkspaces(depsOf(h), {
        graphRunId: h.graphRunId,
        includeStaleNodes: true,
      });

      expect(results).toEqual([]);
      expect(existsSync(stale)).toBe(true);
      expect(existsSync(failedToLaunch)).toBe(true);
      expect(existsSync(ready)).toBe(true);
      expect(workspaceBytesOf(h.db, h.graphRunId)).toBe(300);
    } finally {
      h.close();
    }
  });

  it('leaves the run artifacts directory next to the workspaces untouched', () => {
    const h = harness('cancelled');
    try {
      const stale = addNode(h, 1, 'stale', 100);
      setRunBytes(h, 100);
      const artifacts = dirnameOfRun(h, 'artifacts');
      mkdirSync(artifacts, { recursive: true });
      writeFileSync(join(artifacts, 'evidence.json'), '{}\n');

      cleanupTerminalGraphRunWorkspaces(depsOf(h), {
        graphRunId: h.graphRunId,
        includeStaleNodes: true,
      });

      expect(existsSync(stale)).toBe(false);
      expect(existsSync(join(artifacts, 'evidence.json'))).toBe(true);
    } finally {
      h.close();
    }
  });

  it('keeps the workspace and the byte counter when the server reap refuses the kill', () => {
    const h = harness('cancelled');
    try {
      const dir = addNode(h, 1, 'stale', 100);
      const cwd = join(dir, 'web');
      setRunBytes(h, 100);
      const startedAt = '2026-08-12T00:00:00.000Z';
      h.db
        .prepare(
          `INSERT INTO servers (ticket_id, repo, pid, status, cwd, started_at)
           VALUES (?, 'web', 4242, 'running', ?, ?)`,
        )
        .run(h.ticketId, cwd, startedAt);
      const liveFacts: ProcessFacts = {
        isAlive: (pid) => pid === 4242,
        liveCwd: (pid) => (pid === 4242 ? { path: cwd, deleted: false } : null),
        processStartMs: (pid) => (pid === 4242 ? Date.parse(startedAt) : null),
      };
      killTreeMock.mockReturnValue('denied');

      const result = cleanupTerminalNodeWorkspace(depsOf(h, liveFacts), {
        graphRunId: h.graphRunId,
        nodeRunId: 1,
        includeStaleNodes: true,
      });

      expect(result.kind).toBe('kill-failed');
      expect(existsSync(dir)).toBe(true);
      expect(workspaceBytesOf(h.db, h.graphRunId)).toBe(100);
    } finally {
      h.close();
    }
  });
});

function dirnameOfRun(h: Harness, child: string): string {
  const nodeDir = nodeWorkspaceDir(h.globalRoot, 'proj', h.ticketId, h.graphRunId, 1);
  // `<run>/workspaces/<node>` → `<run>`
  return join(dirname(dirname(nodeDir)), child);
}
