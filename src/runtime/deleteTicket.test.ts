import { describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, type Store } from '../store/db.js';
import { createTicket, getTicket } from '../store/tickets.js';
import { openProcessRun, listProcessRuns } from '../store/processRuns.js';
import { recordTokenUsage, listTokenUsage } from '../store/tokenUsage.js';
import { recordFindings, listFindings } from '../store/reviewFindings.js';
import { makePortAllocator } from '../resolver/allocator.js';
import { createWorktree } from './worktree.js';
import { deleteTicketPermanently } from './deleteTicket.js';

/** The lifecycle's allocator only ever has `release` called on the delete path. */
function allocatorFor(store: Store) {
  return makePortAllocator(store, [4000, 4999]);
}

function git(cwd: string, ...args: string[]): void {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
}

/** A real repo with one commit on `develop`, so a linked worktree can be cut. */
function makeRepo(): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'karst-del-wt-'));
  writeFileSync(join(dir, 'index.js'), 'console.log(1);\n');
  writeFileSync(join(dir, '.gitignore'), 'node_modules/\n');
  git(dir, 'init', '-q', '-b', 'develop');
  git(dir, 'config', 'user.email', 'test@karst.local');
  git(dir, 'config', 'user.name', 'test');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'init');
  return { path: dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe('deleteTicketPermanently', () => {
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

    const deleting = deleteTicketPermanently(store, ticket.id, {
      closePanel,
      reap,
      allocator: allocatorFor(store),
    })
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

  it('returns no reaps for a ticket with no worktrees', async () => {
    const store = openStore(':memory:');
    const ticket = createTicket(store, { key: 'DELETE-NOWT', title: 'no worktrees' });
    const outcome = await deleteTicketPermanently(store, ticket.id, {
      closePanel: () => {},
      reap: async () => {},
      allocator: allocatorFor(store),
    });
    expect(outcome).toEqual({ reapedServers: [], failedWorktrees: 0 });
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
      allocator: allocatorFor(store),
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
      allocator: allocatorFor(store),
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

  // The leak this routing closes (869ed2n50): permanent delete used to remove
  // only the `servers`/`worktrees` rows, leaving the dev server detached — no
  // controlling tty, reparented to init, still holding its port and serving a
  // directory that no longer exists once the ticket's rows (its only handle)
  // were gone. Removal must stop the servers and take the tree off disk while
  // both pid and path are still known, BEFORE the row transaction.
  it('stops the servers inside the ticket worktrees and removes the trees before the rows', async () => {
    const store = openStore(':memory:');
    const repo = makeRepo();
    try {
      const ticket = createTicket(store, { key: 'DELETE-WT', title: 'worktree' });
      const rec = createWorktree(store, {
        ticketId: ticket.id,
        repoPath: repo.path,
        slug: 'DELETE-WT',
        baseRef: 'develop',
      });
      expect(existsSync(rec.path)).toBe(true);
      const allocator = makePortAllocator(store, [4000, 4999]);
      allocator.allocate(ticket.id, 'frontend', ['http']);
      store.db
        .prepare(
          `INSERT INTO servers (ticket_id, repo, host, port, pid, status, log_path, cwd)
           VALUES (?, 'frontend', 'localhost', 3000, NULL, 'running', '/l', ?)`,
        )
        .run(ticket.id, join(rec.path, 'packages', 'web'));

      const outcome = await deleteTicketPermanently(store, ticket.id, {
        closePanel: () => {},
        reap: async () => {},
        allocator,
      });

      expect(existsSync(rec.path)).toBe(false);
      expect(outcome.failedWorktrees).toBe(0);
      // pid is NULL, so the row is cleared rather than a process signalled —
      // the point is the server was dealt with before the tree came down.
      expect(outcome.reapedServers.map((s) => [s.reason, s.outcome])).toEqual([
        ['worktree-removed', 'row-cleared'],
      ]);
      expect(() => getTicket(store, ticket.id)).toThrow();
      const wt = store.db
        .prepare('SELECT COUNT(*) AS n FROM worktrees WHERE ticket_id = ?')
        .get(ticket.id) as { n: number };
      expect(wt.n).toBe(0);
      const ports = store.db
        .prepare('SELECT COUNT(*) AS n FROM port_allocations WHERE ticket_id = ?')
        .get(ticket.id) as { n: number };
      expect(ports.n).toBe(0);
    } finally {
      repo.cleanup();
      store.close();
    }
  });

  // Fault-isolated per row: cleanup must never strand a delete the user asked
  // for. A worktree git refuses to remove is counted and reported, and the
  // tombstone still lands.
  it('still deletes the ticket when a worktree cannot be removed, reporting the failure', async () => {
    const store = openStore(':memory:');
    const ticket = createTicket(store, { key: 'DELETE-BADWT', title: 'bad worktree' });
    store.db
      .prepare(
        `INSERT INTO worktrees (ticket_id, repo, path, branch, base_ref, deps_mode)
         VALUES (?, '/nonexistent/repo', '/nonexistent/worktree', 'b', 'develop', 'inherited')`,
      )
      .run(ticket.id);

    const outcome = await deleteTicketPermanently(store, ticket.id, {
      closePanel: () => {},
      reap: async () => {},
      allocator: allocatorFor(store),
    });

    expect(outcome.failedWorktrees).toBe(1);
    expect(outcome.reapedServers).toEqual([]);
    expect(() => getTicket(store, ticket.id)).toThrow();
    const wt = store.db
      .prepare('SELECT COUNT(*) AS n FROM worktrees WHERE ticket_id = ?')
      .get(ticket.id) as { n: number };
    expect(wt.n).toBe(0);
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
        allocator: allocatorFor(store),
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
});
