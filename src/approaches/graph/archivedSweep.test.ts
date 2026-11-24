/**
 * Archived-ticket graph sweep (T1342): cancel the open runs of archived
 * tickets and remove their terminal runs' node workspaces — never the run's
 * artifacts.
 *
 * Unit-level: temp directories + an in-memory store + fake process facts. No
 * git and no child process.
 */

import { describe, it, expect } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { openStore } from '../../store/db.js';
import { nodeWorkspaceDir } from './workspace/provider.js';
import { workspaceBytesOf } from '../../store/graph/nodeRuns.js';
import {
  ARCHIVED_TICKET_CANCEL_REASON,
  sweepArchivedTicketGraphRuns,
  type SweepArchivedTicketGraphRunsDeps,
} from './archivedSweep.js';
import type { ProcessFacts, ProcessFactsSource } from '../../runtime/serverIdentity.js';
import type { KillOutcome } from '../../runtime/processTree.js';

const NOW = '2026-08-12T02:00:00.000Z';
const ANCIENT = '2026-08-10T00:00:00.000Z';
const STARTED = '2026-08-12T00:00:00.000Z';

type Db = ReturnType<typeof openStore>['db'];

const deadFacts: ProcessFacts = {
  isAlive: () => false,
  liveCwd: () => null,
  processStartMs: () => null,
};
const deadAsyncFacts: ProcessFactsSource = deadFacts;

function withImmediate<T>(db: Db, fn: () => T): T {
  return db.transaction(fn).immediate();
}

interface Harness {
  store: ReturnType<typeof openStore>;
  db: Db;
  projectId: number;
  globalRoot: string;
  close: () => void;
}

function harness(): Harness {
  const store = openStore(':memory:');
  const db = store.db;
  db.pragma('busy_timeout = 0');
  const projectId = Number(
    db.prepare("INSERT INTO projects (slug) VALUES ('proj')").run().lastInsertRowid,
  );
  const globalRoot = mkdtempSync(join(tmpdir(), 'karst-archived-sweep-'));
  return {
    store,
    db,
    projectId,
    globalRoot,
    close: () => {
      store.close();
      rmSync(globalRoot, { recursive: true, force: true });
    },
  };
}

let ticketSeq = 0;
function addTicket(
  h: Harness,
  options: { archivedAt?: string | null; projectId?: number; stage?: string } = {},
): number {
  ticketSeq += 1;
  return Number(
    h.db
      .prepare(
        `INSERT INTO tickets (key, project_id, stage_current, archived_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(
        `T-${ticketSeq}`,
        options.projectId ?? h.projectId,
        options.stage ?? 'done',
        options.archivedAt === undefined ? ANCIENT : options.archivedAt,
      ).lastInsertRowid,
  );
}

function addRun(h: Harness, ticketId: number, status: string, createdAt = STARTED): number {
  return Number(
    h.db
      .prepare(
        `INSERT INTO approach_graph_runs (ticket_id, stage_key, stage_attempt, approach_id, status, created_at)
         VALUES (?, 'impl', 0, 'karst-graph-engineering', ?, ?)`,
      )
      .run(ticketId, status, createdAt).lastInsertRowid,
  );
}

function addRevision(h: Harness, graphRunId: number): number {
  return Number(
    h.db
      .prepare(
        `INSERT INTO approach_graph_revisions
           (graph_run_id, revision_number, canonical_graph, fingerprint, status, created_at)
         VALUES (?, 1, '{}', 'fp', 'active', ?)`,
      )
      .run(graphRunId, STARTED).lastInsertRowid,
  );
}

/** Create the authoritative workspace layout plus its ledger row. */
function addNode(
  h: Harness,
  params: {
    ticketId: number;
    graphRunId: number;
    revisionId: number;
    nodeRunId: number;
    status: string;
    bytes?: number;
    processRunId?: number | null;
    slug?: string;
  },
): string {
  h.db
    .prepare(
      `INSERT INTO approach_node_runs
         (id, graph_run_id, revision_id, node_id, node_kind, visit_number, status, process_run_id)
       VALUES (?, ?, ?, ?, 'agent', 1, ?, ?)`,
    )
    .run(
      params.nodeRunId,
      params.graphRunId,
      params.revisionId,
      `worker-${params.nodeRunId}`,
      params.status,
      params.processRunId ?? null,
    );
  const nodeDir = nodeWorkspaceDir(
    h.globalRoot,
    params.slug ?? 'proj',
    params.ticketId,
    params.graphRunId,
    params.nodeRunId,
  );
  const cwd = join(nodeDir, 'web');
  mkdirSync(cwd, { recursive: true });
  writeFileSync(join(cwd, 'index.ts'), 'export {}\n');
  h.db
    .prepare(
      `INSERT INTO approach_graph_workspaces (graph_run_id, node_run_id, repo_name, cwd, byte_size, created_at)
       VALUES (?, ?, 'web', ?, ?, ?)`,
    )
    .run(params.graphRunId, params.nodeRunId, cwd, params.bytes ?? 100, STARTED);
  return nodeDir;
}

function setRunBytes(h: Harness, graphRunId: number, bytes: number): void {
  h.db
    .prepare('UPDATE approach_graph_runs SET workspace_bytes = ? WHERE id = ?')
    .run(bytes, graphRunId);
}

function artifactsDir(h: Harness, slug: string, ticketId: number, graphRunId: number): string {
  const nodeDir = nodeWorkspaceDir(h.globalRoot, slug, ticketId, graphRunId, 999);
  return join(dirname(dirname(nodeDir)), 'artifacts');
}

interface SweepOptions {
  isSessionLive?: (ticketId: number) => boolean;
  facts?: ProcessFactsSource;
  killTree?: (pid: number) => KillOutcome;
  now?: string;
  graceMs?: number;
  debugLines?: string[];
}

function sweep(
  h: Harness,
  projectId: number,
  options: SweepOptions = {},
): Promise<Awaited<ReturnType<typeof sweepArchivedTicketGraphRuns>>> {
  const deps: SweepArchivedTicketGraphRunsDeps = {
    store: h.store,
    transaction: <T>(fn: () => T): T => withImmediate(h.db, fn),
    facts: options.facts ?? deadAsyncFacts,
    cleanupFacts: deadFacts,
    killTree: options.killTree ?? (() => 'killed'),
    isSessionLive: options.isSessionLive,
    now: () => options.now ?? NOW,
    graceMs: options.graceMs,
    debug: options.debugLines ? (m) => options.debugLines!.push(m) : undefined,
  };
  return sweepArchivedTicketGraphRuns(deps, projectId);
}

const statusOfRun = (h: Harness, id: number): string =>
  (h.db.prepare('SELECT status FROM approach_graph_runs WHERE id = ?').get(id) as { status: string })
    .status;

describe('sweepArchivedTicketGraphRuns', () => {
  it('removes the node workspaces of a cancelled run of an archived ticket (SQLite archived_at)', async () => {
    const h = harness();
    try {
      const ticketId = addTicket(h, { archivedAt: '2026-08-10 00:00:00' });
      const runId = addRun(h, ticketId, 'cancelled');
      const revisionId = addRevision(h, runId);
      const nodeDir = addNode(h, { ticketId, graphRunId: runId, revisionId, nodeRunId: 1, status: 'completed' });
      setRunBytes(h, runId, 500);
      const artifacts = artifactsDir(h, 'proj', ticketId, runId);
      mkdirSync(artifacts, { recursive: true });
      writeFileSync(join(artifacts, 'evidence.json'), '{}\n');

      const result = await sweep(h, h.projectId);

      expect(result.removedNodeRunIds).toEqual([1]);
      expect(result.releasedBytes).toBe(100);
      expect(existsSync(nodeDir)).toBe(false);
      expect(existsSync(join(artifacts, 'evidence.json'))).toBe(true);
      expect(workspaceBytesOf(h.db, runId)).toBe(400);
    } finally {
      h.close();
    }
  });

  it('removes the node workspaces of a closed run of an archived ticket (ISO archived_at)', async () => {
    const h = harness();
    try {
      const ticketId = addTicket(h, { archivedAt: '2026-08-10T00:00:00.000Z' });
      const runId = addRun(h, ticketId, 'closed');
      const revisionId = addRevision(h, runId);
      const nodeDir = addNode(h, { ticketId, graphRunId: runId, revisionId, nodeRunId: 2, status: 'stale' });
      setRunBytes(h, runId, 100);

      const result = await sweep(h, h.projectId);

      expect(result.removedNodeRunIds).toEqual([2]);
      expect(existsSync(nodeDir)).toBe(false);
      expect(workspaceBytesOf(h.db, runId)).toBe(0);
    } finally {
      h.close();
    }
  });

  it.each(['stale', 'failed-to-launch', 'ready'])(
    'removes a %s node left inside a cancelled run',
    async (status) => {
      const h = harness();
      try {
        const ticketId = addTicket(h);
        const runId = addRun(h, ticketId, 'cancelled');
        const revisionId = addRevision(h, runId);
        const nodeDir = addNode(h, {
          ticketId,
          graphRunId: runId,
          revisionId,
          nodeRunId: 3,
          status,
        });

        const result = await sweep(h, h.projectId);

        expect(result.removedNodeRunIds).toEqual([3]);
        expect(existsSync(nodeDir)).toBe(false);
      } finally {
        h.close();
      }
    },
  );

  it('leaves a not-archived done ticket untouched', async () => {
    const h = harness();
    try {
      const ticketId = addTicket(h, { archivedAt: null });
      const runId = addRun(h, ticketId, 'cancelled');
      const revisionId = addRevision(h, runId);
      const nodeDir = addNode(h, { ticketId, graphRunId: runId, revisionId, nodeRunId: 4, status: 'stale' });

      const result = await sweep(h, h.projectId);

      expect(result).toEqual({
        cancelledRunIds: [],
        refusedRunIds: [],
        removedNodeRunIds: [],
        releasedBytes: 0,
      });
      expect(existsSync(nodeDir)).toBe(true);
    } finally {
      h.close();
    }
  });

  it.each([
    ['less than an hour ago', '2026-08-12T01:30:00.000Z'],
    ['exactly an hour ago', '2026-08-12T01:00:00.000Z'],
  ])('leaves a ticket archived %s alone', async (_label, archivedAt) => {
    const h = harness();
    try {
      const ticketId = addTicket(h, { archivedAt });
      const runId = addRun(h, ticketId, 'cancelled');
      const revisionId = addRevision(h, runId);
      const nodeDir = addNode(h, { ticketId, graphRunId: runId, revisionId, nodeRunId: 5, status: 'stale' });

      const result = await sweep(h, h.projectId);

      expect(result.removedNodeRunIds).toEqual([]);
      expect(existsSync(nodeDir)).toBe(true);
    } finally {
      h.close();
    }
  });

  it('leaves a ticket with a live session untouched', async () => {
    const h = harness();
    try {
      const ticketId = addTicket(h);
      const runId = addRun(h, ticketId, 'cancelled');
      const revisionId = addRevision(h, runId);
      const nodeDir = addNode(h, { ticketId, graphRunId: runId, revisionId, nodeRunId: 6, status: 'stale' });

      const result = await sweep(h, h.projectId, { isSessionLive: (id) => id === ticketId });

      expect(result.removedNodeRunIds).toEqual([]);
      expect(existsSync(nodeDir)).toBe(true);
    } finally {
      h.close();
    }
  });

  it("leaves another project's ticket untouched", async () => {
    const h = harness();
    try {
      const otherProjectId = Number(
        h.db.prepare("INSERT INTO projects (slug) VALUES ('other')").run().lastInsertRowid,
      );
      const ticketId = addTicket(h, { projectId: otherProjectId });
      const runId = addRun(h, ticketId, 'cancelled');
      const revisionId = addRevision(h, runId);
      const nodeDir = addNode(h, {
        ticketId,
        graphRunId: runId,
        revisionId,
        nodeRunId: 7,
        status: 'stale',
        slug: 'other',
      });

      const result = await sweep(h, h.projectId);

      expect(result.removedNodeRunIds).toEqual([]);
      expect(existsSync(nodeDir)).toBe(true);
    } finally {
      h.close();
    }
  });

  it('never removes a running node inside a cancelled run', async () => {
    const h = harness();
    try {
      const ticketId = addTicket(h);
      const runId = addRun(h, ticketId, 'cancelled');
      const revisionId = addRevision(h, runId);
      const nodeDir = addNode(h, { ticketId, graphRunId: runId, revisionId, nodeRunId: 8, status: 'running' });
      setRunBytes(h, runId, 100);

      const result = await sweep(h, h.projectId);

      expect(result.removedNodeRunIds).toEqual([]);
      expect(existsSync(nodeDir)).toBe(true);
      expect(workspaceBytesOf(h.db, runId)).toBe(100);
    } finally {
      h.close();
    }
  });

  it('cancels an open run of an archived ticket with reason `ticket archived`, then cleans it', async () => {
    const h = harness();
    try {
      const ticketId = addTicket(h);
      const runId = addRun(h, ticketId, 'running');
      const revisionId = addRevision(h, runId);
      const nodeDir = addNode(h, { ticketId, graphRunId: runId, revisionId, nodeRunId: 9, status: 'completed' });
      setRunBytes(h, runId, 100);

      const result = await sweep(h, h.projectId);

      expect(result.cancelledRunIds).toEqual([runId]);
      expect(result.refusedRunIds).toEqual([]);
      expect(statusOfRun(h, runId)).toBe('cancelled');
      const row = h.db
        .prepare('SELECT blocked_reason, active_processes FROM approach_graph_runs WHERE id = ?')
        .get(runId) as { blocked_reason: string; active_processes: number };
      expect(row.blocked_reason).toBe(ARCHIVED_TICKET_CANCEL_REASON);
      expect(row.active_processes).toBe(0);
      expect(result.removedNodeRunIds).toEqual([9]);
      expect(existsSync(nodeDir)).toBe(false);
    } finally {
      h.close();
    }
  });

  it('keeps the run and its workspaces when the cancel refuses a live process', async () => {
    const h = harness();
    try {
      const ticketId = addTicket(h);
      const runId = addRun(h, ticketId, 'running');
      const revisionId = addRevision(h, runId);
      const processRunId = Number(
        h.db
          .prepare(
            `INSERT INTO process_runs (ticket_id, stage_key, process_id, attempt, pid, status, started_at)
             VALUES (?, 'impl', 'graph', 0, 4242, 'running', ?)`,
          )
          .run(ticketId, STARTED).lastInsertRowid,
      );
      const nodeDir = addNode(h, {
        ticketId,
        graphRunId: runId,
        revisionId,
        nodeRunId: 10,
        status: 'running',
        processRunId,
      });
      const debugLines: string[] = [];
      const liveFacts: ProcessFactsSource = {
        isAlive: (pid) => pid === 4242,
        liveCwd: () => null,
        processStartMs: (pid) => (pid === 4242 ? Date.parse(STARTED) : null),
      };

      const result = await sweep(h, h.projectId, {
        facts: liveFacts,
        killTree: () => 'denied',
        debugLines,
      });

      expect(result.refusedRunIds).toEqual([runId]);
      expect(result.cancelledRunIds).toEqual([]);
      expect(statusOfRun(h, runId)).toBe('running');
      expect(existsSync(nodeDir)).toBe(true);
      expect(debugLines.filter((line) => line.includes('archived sweep'))).toEqual([
        expect.stringContaining(String(runId)),
      ]);
    } finally {
      h.close();
    }
  });
});
