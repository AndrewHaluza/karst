import { describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../store/db.js';
import { createTicket, getTicket } from '../store/tickets.js';
import { openProcessRun, listProcessRuns } from '../store/processRuns.js';
import { recordTokenUsage, listTokenUsage } from '../store/tokenUsage.js';
import { recordFindings, listFindings } from '../store/reviewFindings.js';
import { makePortAllocator } from '../resolver/allocator.js';
import { createWorktree } from './worktree.js';
import { deleteTicketPermanently } from './deleteTicket.js';

/** A minimal real repo so `removeWorktree` can exercise git for real. */
function makeRepo(): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'karst-del-wt-'));
  writeFileSync(join(dir, 'index.js'), 'console.log(1);\n');
  const git = (cwd: string, ...args: string[]): void => {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  };
  git(dir, 'init', '-q', '-b', 'develop');
  git(dir, 'config', 'user.email', 'test@karst.local');
  git(dir, 'config', 'user.name', 'test');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'init');
  return { path: dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const branchExists = (repo: string, branch: string): boolean =>
  spawnSync('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], {
    cwd: repo,
    encoding: 'utf8',
  }).status === 0;


describe('deleteTicketPermanently', () => {
  const noPorts = (): { allocate: () => Record<string, number>; release: () => void } => ({
    allocate: () => ({}),
    release: () => {},
  });

  it('closes the bound panel, deletes rows, and waits for attachment cleanup', async () => {
    const store = openStore(':memory:');
    const ticket = createTicket(store, { key: 'DELETE-1', title: 'delete me' });
    let releaseCleanup: (() => void) | undefined;
    const cleanup = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    const closePanel = vi.fn(() => {
      expect(() => getTicket(store, ticket.id)).toThrow();
    });
    const reap = vi.fn(async () => {
      expect(() => getTicket(store, ticket.id)).toThrow();
      await cleanup;
    });
    let settled = false;

    const deleting = deleteTicketPermanently(store, ticket.id, { closePanel, reap, ports: noPorts() })
      .then(() => {
        settled = true;
      });
    await Promise.resolve();

    expect(closePanel).toHaveBeenCalledWith(ticket.id);
    expect(reap).toHaveBeenCalledWith(ticket.id);
    expect(settled).toBe(false);

    releaseCleanup?.();
    await deleting;
    expect(settled).toBe(true);
    store.close();
  });

  it('propagates attachment cleanup failure after deleting the ticket', async () => {
    const store = openStore(':memory:');
    const ticket = createTicket(store, { key: 'DELETE-2', title: 'delete me too' });

    await expect(deleteTicketPermanently(store, ticket.id, {
      closePanel: () => {},
      reap: async () => {
        throw new Error('disk denied');
      },
      ports: noPorts(),
    })).rejects.toThrow('disk denied');

    expect(() => getTicket(store, ticket.id)).toThrow();
    store.close();
  });

  it('deletes a ticket whose evidence links to its process runs, ledger intact', async () => {
    const store = openStore(':memory:');
    const ticket = createTicket(store, { key: 'DELETE-3', title: 'linked' });
    const run = openProcessRun(store, {
      ticketId: ticket.id,
      stageKey: 'review',
      processId: 'review',
      attempt: 0,
      startedAt: '2026-08-01T10:00:00.000Z',
    });
    recordTokenUsage(store, {
      projectId: 1,
      ticketId: ticket.id,
      processRunId: run.id,
      callSite: 'fix-resume',
      outcome: 'ok',
      usage: {
        inputTokens: 60,
        outputTokens: 20,
        reasoningTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 80,
        model: null,
        estimated: false,
      },
    });
    recordFindings(store, {
      ticketId: ticket.id,
      attempt: 0,
      runAt: '2026-08-01T12:00:00.000Z',
      processRunId: run.id,
      findings: [
        {
          severity: 'high',
          repo: '/web',
          file: null,
          line: null,
          title: 'boom',
          detail: 'd',
          source: 'agent',
        },
      ],
    });

    await deleteTicketPermanently(store, ticket.id, {
      closePanel: () => {},
      reap: async () => {},
      ports: noPorts(),
    });

    expect(() => getTicket(store, ticket.id)).toThrow();
    expect(listProcessRuns(store, ticket.id)).toEqual([]);
    expect(listFindings(store, ticket.id)).toEqual([]);
    // The surviving ledger row keeps its counts, unattributed to ticket or run.
    const surviving = listTokenUsage(store, {});
    expect(surviving).toHaveLength(1);
    expect(surviving[0]!.ticketId).toBeNull();
    expect(surviving[0]!.processRunId).toBeNull();
    expect(surviving[0]!.totalTokens).toBe(80);
    store.close();
  });

  // The byte halves of permanent delete — the graph byte subtree and the gate
  // console-log dir — are threaded through the lifecycle roots exactly like the
  // row half: removed AFTER the rows commit, missing directories being normal.
  it('removes the graph byte subtree and the artifact console-log dir through the lifecycle roots', async () => {
    const store = openStore(':memory:');
    const ticket = createTicket(store, { key: 'DELETE-4', title: 'bytes' });
    const dir = mkdtempSync(join(tmpdir(), 'karst-del-bytes-'));
    try {
      const graphBytesRoot = join(dir, 'graph', 'project');
      const artifactsRoot = join(dir, 'artifacts');
      for (const root of [graphBytesRoot, artifactsRoot]) {
        mkdirSync(join(root, String(ticket.id), 'artifacts'), { recursive: true });
      }

      await deleteTicketPermanently(store, ticket.id, {
        closePanel: () => {},
        reap: async () => {},
        ports: noPorts(),
        graphBytesRoot,
        artifactsRoot,
      });

      expect(existsSync(join(graphBytesRoot, String(ticket.id)))).toBe(false);
      expect(existsSync(join(artifactsRoot, String(ticket.id)))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    store.close();
  });

  // P1-03 regression: a permanent delete must go through `removeWorktree` — the
  // "single choke point for removal" — so the ticket's live servers, its
  // worktree directory, its branch and its port allocation do not outlive the
  // rows. The row-only delete this test guards left a detached server with no
  // `servers` row any sweep could see, plus an orphan worktree + branch on disk.
  it('stops servers and removes the worktree directory, branch and port allocation', async () => {
    const store = openStore(':memory:');
    const ticket = createTicket(store, { key: 'DELETE-5', title: 'leaky' });
    const repo = makeRepo();
    try {
      const rec = createWorktree(store, {
        ticketId: ticket.id,
        repoPath: repo.path,
        slug: 'DELETE-5-leaky',
        baseRef: 'develop',
      });
      expect(existsSync(rec.path)).toBe(true);
      expect(branchExists(repo.path, rec.branch)).toBe(true);

      // A server running INSIDE the worktree, and its recorded port allocation.
      store.db
        .prepare(
          `INSERT INTO servers (ticket_id, repo, host, port, pid, status, log_path, cwd, started_at, container)
           VALUES (?, 'frontend', 'localhost', 4000, NULL, 'running', '/l', ?, '2026-08-01T10:00:00.000Z', NULL)`,
        )
        .run(ticket.id, rec.path);
      const allocator = makePortAllocator(store, [4000, 4100]);
      allocator.allocate(ticket.id, 'frontend', ['web']);
      expect(store.db.prepare('SELECT COUNT(*) AS n FROM port_allocations WHERE ticket_id = ?').get(ticket.id)).toEqual({ n: 1 });

      await deleteTicketPermanently(store, ticket.id, {
        closePanel: () => {},
        reap: async () => {},
        ports: allocator,
      });

      // Rows gone.
      expect(() => getTicket(store, ticket.id)).toThrow();
      expect(store.db.prepare('SELECT COUNT(*) AS n FROM worktrees WHERE ticket_id = ?').get(ticket.id)).toEqual({ n: 0 });
      expect(store.db.prepare('SELECT COUNT(*) AS n FROM servers WHERE ticket_id = ?').get(ticket.id)).toEqual({ n: 0 });
      // Worktree directory, branch and port allocation gone.
      expect(existsSync(rec.path)).toBe(false);
      expect(branchExists(repo.path, rec.branch)).toBe(false);
      expect(store.db.prepare('SELECT COUNT(*) AS n FROM port_allocations WHERE ticket_id = ?').get(ticket.id)).toEqual({ n: 0 });
    } finally {
      repo.cleanup();
    }
    store.close();
  });
});
