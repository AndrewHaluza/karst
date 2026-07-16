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
/**
 * Why a service wouldn't start, in words the user can act on.
 *
 * Service commands are arbitrary strings from the manifest, so karst cannot
 * preflight them the way it preflights its own tools (see runtime/deps.ts) —
 * this is the only place a typo'd or uninstalled service command can be
 * explained. Name the service, the binary, and where it was configured; "spawn
 * docker ENOENT" is true and useless.
 */
function startError(opts: StartHotOpts, err: Error & { code?: string }): Error {
  if (err.code === 'ENOENT') {
    return new Error(
      `could not start '${opts.service}': '${opts.command}' is not installed, or not on the ` +
        `PATH this editor was launched with. It comes from the start command for '${opts.service}' ` +
        `in karst.yml.`,
    );
  }
  return new Error(`could not start '${opts.service}': ${err.message}`);
}

/** Rejects with `err` after `ms`, without holding the process open. */
function rejectAfter(ms: number, err: Error): Promise<never> {
  return new Promise((_, reject) => setTimeout(() => reject(err), ms).unref());
}

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

  // A failed spawn (ENOENT) reports itself through an ASYNC 'error' event, and an
  // 'error' event with no listener THROWS — unhandled, in the extension host, from
  // a stack naming neither the service nor the command. Listen before anything can
  // fire, and keep the rejection handled until something races it.
  const spawnFailed = new Promise<never>((_, reject) => {
    child.once('error', (err: Error & { code?: string }) => reject(startError(opts, err)));
  });
  spawnFailed.catch(() => {});

  const pid = child.pid;
  if (pid === undefined) {
    // No pid means the spawn failed; the reason is a tick behind us on the
    // 'error' event. Wait for it rather than throw a bare "no pid" — but never
    // wait forever for an event that may not be coming. Both arms reject, so the
    // throw below is unreachable; it is what tells the compiler (and the next
    // reader) that this branch cannot fall through to a start with no process.
    await Promise.race([
      spawnFailed,
      rejectAfter(2000, new Error(`could not start '${opts.service}': no pid`)),
    ]);
    throw new Error(`could not start '${opts.service}': no pid`);
  }

  try {
    // Race the spawn failure: an error that arrives after a pid did (EACCES on
    // the binary, say) would otherwise sit unheard until the health check times
    // out, turning an instant, explainable failure into a slow, silent one.
    await Promise.race([
      waitForHealth(opts.healthUrl, {
        timeoutMs: opts.healthTimeoutMs,
        signal: opts.signal,
      }),
      spawnFailed,
    ]);
  } catch (err) {
    // Health failed or the start was cancelled — reap the whole tree, not just
    // the launcher, so no dev server is left running.
    killTree(pid);
    throw err;
  }

  // Single row per (ticket, service): drop any prior row for this service first
  // — including a retained 'stopped' one from a previous run — so restarting a
  // stopped server replaces its offline row instead of accumulating duplicates.
  // `IS` is null-safe, so baseline servers (ticket_id NULL) match correctly.
  store.db
    .prepare('DELETE FROM servers WHERE service = ? AND ticket_id IS ?')
    .run(opts.service, opts.ticketId);

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
  pid: number | null;
  status: string;
}

/**
 * Kill a server's process and RETAIN its row as `status='stopped'` (pid nulled).
 * Idempotent (no row → no-op; already-stopped → no re-kill). Retaining rather
 * than deleting lets a stopped server surface on the dashboard as offline so the
 * user can restart it, instead of silently vanishing. Duplicate accumulation is
 * prevented at the other end: `startHot` drops any prior row for the same
 * (ticket, service) before inserting the fresh running one.
 */
export function stopServer(store: Store, id: number): void {
  const row = store.db
    .prepare('SELECT pid, status FROM servers WHERE id = ?')
    .get(id) as ServerRow | undefined;
  if (!row) return;

  if (row.status === 'running' && row.pid != null) {
    // Group kill so a launcher's grandchildren (Vite etc.) die with it.
    killTree(row.pid);
  }
  store.db.prepare("UPDATE servers SET status = 'stopped', pid = NULL WHERE id = ?").run(id);
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
