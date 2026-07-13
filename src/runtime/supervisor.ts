import { spawn } from 'node:child_process';
import { openSync, closeSync, readFileSync, existsSync } from 'node:fs';
import type { Store } from '../store/db.js';
import { waitForHealth } from './health.js';

/**
 * SIGKILL a process AND its descendants. Children are spawned `detached`, making
 * the child the leader of its own process group whose id equals its pid; killing
 * the negative pid reaps the whole group — critical for launchers like `npm run
 * dev` that fork a grandchild (Vite) which a plain `child.kill()` would orphan.
 * Falls back to a direct kill if the group signal fails, and swallows ESRCH
 * (already gone). Never throws.
 */
export function killTree(pid: number): void {
  try {
    process.kill(-pid, 'SIGKILL'); // negative pid = the whole process group
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // already gone
    }
  }
}

export interface ServerRecord {
  id: number;
  ticketId: number | null;
  service: string;
  host: string;
  port: number;
  pid: number;
  status: 'running' | 'stopped';
  logPath: string;
}

export interface StartHotOpts {
  ticketId: number | null;
  service: string;
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  host: string;
  port: number;
  healthUrl: string;
  logPath: string;
  healthTimeoutMs?: number;
  /** Abort the health-gated start early (spin cancellation). */
  signal?: AbortSignal;
}

/**
 * Start a hot service, health-gate it, and record it in `servers` (§10, §7.2
 * step 4). Resolves only after the health check passes; if health never passes,
 * the child is killed and the call rejects. stdout/stderr stream to logPath.
 */
export async function startHot(store: Store, opts: StartHotOpts): Promise<ServerRecord> {
  const logFd = openSync(opts.logPath, 'a');

  let child;
  try {
    child = spawn(opts.command, opts.args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      stdio: ['ignore', logFd, logFd],
      // Own process group so killTree can reap grandchildren (e.g. `npm run dev`
      // → Vite). Without this a health-fail/cancel orphans the real server.
      detached: true,
    });
  } finally {
    // The child holds its own duplicated fd via the stdio array; close the
    // parent's copy so a long-running daemon doesn't leak one fd per start.
    closeSync(logFd);
  }

  const pid = child.pid;
  if (pid === undefined) {
    throw new Error(`failed to spawn ${opts.service}: no pid`);
  }

  try {
    await waitForHealth(opts.healthUrl, {
      timeoutMs: opts.healthTimeoutMs,
      signal: opts.signal,
    });
  } catch (err) {
    // Health failed or the start was cancelled — reap the whole tree, not just
    // the launcher, so no dev server is left running.
    killTree(pid);
    throw err;
  }

  const info = store.db
    .prepare(
      `INSERT INTO servers (ticket_id, service, host, port, pid, status, log_path)
       VALUES (?, ?, ?, ?, ?, 'running', ?)`,
    )
    .run(opts.ticketId, opts.service, opts.host, opts.port, pid, opts.logPath);

  return {
    id: Number(info.lastInsertRowid),
    ticketId: opts.ticketId,
    service: opts.service,
    host: opts.host,
    port: opts.port,
    pid,
    status: 'running',
    logPath: opts.logPath,
  };
}

interface ServerRow {
  pid: number;
  status: string;
}

/**
 * Kill a server's process and remove its row. Idempotent (no row → no-op).
 * Deleting rather than marking `status='stopped'` keeps the dashboard's server
 * list to only live servers — stale 'stopped' rows accumulated across re-spins
 * otherwise, showing dead servers alongside the running one.
 */
export function stopServer(store: Store, id: number): void {
  const row = store.db
    .prepare('SELECT pid, status FROM servers WHERE id = ?')
    .get(id) as ServerRow | undefined;
  if (!row) return;

  if (row.status === 'running') {
    // Group kill so a launcher's grandchildren (Vite etc.) die with it.
    killTree(row.pid);
  }
  store.db.prepare('DELETE FROM servers WHERE id = ?').run(id);
}

/**
 * Stop every running server belonging to a ticket. Used before a re-spin so a
 * prior run's live servers are reaped (process + row) instead of orphaned — a
 * retry that re-resolves the same port would otherwise spawn a second server
 * fighting the first for the port. Idempotent; each stop is isolated.
 */
export function stopTicketServers(store: Store, ticketId: number): void {
  const rows = store.db
    .prepare("SELECT id FROM servers WHERE ticket_id = ? AND status = 'running'")
    .all(ticketId) as { id: number }[];
  for (const { id } of rows) stopServer(store, id);
}

/** Read the current contents of a server's log file (§10 log-tail). */
export function tailLog(record: Pick<ServerRecord, 'logPath'>): string {
  if (!existsSync(record.logPath)) return '';
  return readFileSync(record.logPath, 'utf8');
}
