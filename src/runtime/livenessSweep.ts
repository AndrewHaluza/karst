import type { Store } from '../store/db.js';
import { groupLiveness, lastExitCode, type GroupLiveness } from './supervisor.js';
import { markServerCrashed } from '../store/serverCrash.js';
import { pidAlive } from './pidAlive.js';
import { connect } from 'node:net';
import { isContainerRunning } from './orphanContainers.js';
import { formatId } from '../model/entityId.js';

/**
 * Mark `running` server rows whose process is actually gone as `failed`.
 *
 * The panels render each row's `status` column verbatim, so a row that claims
 * `running` keeps claiming it until something re-derives the truth.
 * `reconcileOnStart` does that once, at activation, and writes `stopped`: a
 * server that ended with the closed window is not a crash seen live. This sweep
 * runs while the window is open, and what it sees IS a crash, so it writes the
 * existing `failed` state with a reason (`markServerCrashed`). It never writes
 * `stopped`: a stop is a user action (@arch:SERVERS-PANEL).
 *
 * A row with a pid is crashed only when ALL three answers agree: the pid is
 * dead, its process group is not `'alive'`, and the recorded `host:port`
 * definitively refuses (`probeReachable` → `false`). The port check is
 * required, not decorative: a launcher that daemonises (`docker compose up -d`,
 * `spawn(..., { detached: true }).unref()`) exits 0 with its own group empty
 * while the daemon it left behind keeps serving. That is the `abandonVerdict`
 * rule without the grace. On Windows the group answer is `'unknown'`, so the
 * rule is pid + port. A row with no host or port is never flipped: nothing can
 * prove it dead.
 *
 * A row with a `container` is judged by `docker ps` only, with or without a
 * client pid: a dead `docker run` client with a live container is a live
 * service, and a port check would be fooled by another ticket on the same port.
 * A pid-NULL row with no container (a sandbox row) is crashed when its port
 * refuses. The sweep NEVER tears a container down: only the explicit stop and
 * reap paths remove containers.
 *
 * A probe that throws or never answers leaves the row ALONE. Absence of evidence
 * is not evidence of death, so a timeout (`undefined`) is alive. Nothing here
 * signals a process: a false "alive" costs a stale row until the next pass,
 * whereas a false "dead" would show a live service as Failed.
 */

export interface CrashedServer {
  id: number;
  ticketId: number | null;
  service: string;
  pid: number | null;
  /** The short reason written to `servers.last_error`. */
  reason: string;
}

/** The reason when no exit code is known (another window started it, or a signal). */
export const CRASH_REASON_UNKNOWN = 'Exited unexpectedly';

export interface SweepLivenessOpts {
  /** Limit the sweep to one ticket's rows. Omit to sweep every running row. */
  ticketId?: number;
  /** Injected for tests. Defaults to the real probes. */
  isPidAlive?: (pid: number) => boolean;
  /** The process group of a recorded pid. Defaults to `groupLiveness`. */
  isGroupAlive?: (pid: number) => GroupLiveness;
  /**
   * Reachability of a recorded address, in three states: `true` (something
   * accepts connections), `false` (definitively refused), or `undefined` (no
   * answer in time — timeout / no route). `undefined` is NOT death, so the row
   * is left running. Defaults to `probeReachable`.
   */
  portOpen?: (host: string, port: number) => Promise<boolean | undefined>;
  /** Injected for tests. Defaults to `docker ps`. `undefined` = docker did not answer. */
  containerRunning?: (name: string) => Promise<boolean | undefined>;
  /** Non-zero exit codes by row id. Defaults to the supervisor's `lastExitCode`. */
  exitCodes?: Map<number, number>;
  debug?: (message: string) => void;
}

/**
 * A bounded TCP probe with three outcomes. `isPortOpen` deliberately folds
 * every failure into `false`: a port-conflict PREFLIGHT may read an unanswered
 * port as one it can try. A liveness check must not — a filtered port or an
 * overloaded host would then fail a healthy service. Only a definitive
 * `ECONNREFUSED` is evidence the listener is gone; a timeout is `undefined`.
 */
export function probeReachable(
  host: string,
  port: number,
  timeoutMs = 1_000,
): Promise<boolean | undefined> {
  return new Promise((resolve) => {
    const sock = connect({ host, port });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settle = (value: boolean | undefined): void => {
      if (timer !== undefined) clearTimeout(timer);
      sock.destroy();
      resolve(value);
    };
    timer = setTimeout(() => settle(undefined), timeoutMs);
    timer.unref?.();
    sock.once('connect', () => settle(true));
    sock.once('error', (err) => {
      settle((err as NodeJS.ErrnoException).code === 'ECONNREFUSED' ? false : undefined);
    });
  });
}

interface RunningServerRow {
  id: number;
  ticketId: number | null;
  repo: string;
  pid: number | null;
  host: string | null;
  port: number | null;
  container: string | null;
  sandbox: string | null;
}

interface Probes {
  isPidAlive: (pid: number) => boolean;
  isGroupAlive: (pid: number) => GroupLiveness;
  portOpen: (host: string, port: number) => Promise<boolean | undefined>;
  containerRunning: (name: string) => Promise<boolean | undefined>;
}

/** True only when the evidence proves the row's service is gone. */
async function isCrashed(row: RunningServerRow, p: Probes): Promise<boolean> {
  if (row.container !== null) return (await p.containerRunning(row.container)) === false;
  if (row.pid !== null) {
    if (p.isPidAlive(row.pid)) return false;
    if (p.isGroupAlive(row.pid) === 'alive') return false;
  }
  if (row.host === null || row.port === null) return false;
  return (await p.portOpen(row.host, row.port)) === false;
}

export async function sweepServerLiveness(
  store: Store,
  opts: SweepLivenessOpts = {},
): Promise<CrashedServer[]> {
  const probes: Probes = {
    isPidAlive: opts.isPidAlive ?? pidAlive,
    isGroupAlive: opts.isGroupAlive ?? groupLiveness,
    portOpen: opts.portOpen ?? probeReachable,
    containerRunning: opts.containerRunning ?? ((name) => isContainerRunning(name)),
  };
  const exitCodes = opts.exitCodes ?? lastExitCode;

  let sql = "SELECT id, ticket_id AS ticketId, repo, pid, host, port, container, sandbox FROM servers WHERE status = 'running' AND kind = 'service'";
  const params: number[] = [];
  if (opts.ticketId !== undefined) {
    sql += ' AND ticket_id = ?';
    params.push(opts.ticketId);
  }

  const rows = store.db.prepare(sql).all(...params) as RunningServerRow[];
  const crashed: CrashedServer[] = [];

  for (const row of rows) {
    try {
      if (!(await isCrashed(row, probes))) continue;
      const code = exitCodes.get(row.id);
      const reason = code === undefined ? CRASH_REASON_UNKNOWN : `Exited with code ${code}`;
      // The guard in `markServerCrashed` drops the write when a user Stop or a
      // restart changed the row while the probes ran.
      if (!markServerCrashed(store, row.id, row.pid, reason)) continue;
      exitCodes.delete(row.id);
      opts.debug?.(
        `[runtime] server ${row.id} (${row.repo}, pid ${row.pid ?? 'unknown'}) failed — ${reason}; nothing bound on ${row.host ?? '?'}:${row.port ?? '?'}${row.container === null ? '' : ` (container ${row.container} is not running)`}`,
      );
      crashed.push({ id: row.id, ticketId: row.ticketId, service: row.repo, pid: row.pid, reason });
    } catch (err) {
      opts.debug?.(
        `[runtime] liveness probe for server ${row.id} failed; leaving it running (${String(err)})`,
      );
      continue;
    }
  }

  return crashed;
}

export function describeCrashed(s: CrashedServer): string {
  return `karst: '${s.service}' exited unexpectedly (pid ${s.pid ?? 'unknown'})` +
    `${s.ticketId === null ? '' : ` on ticket ${formatId('ticket', s.ticketId)}`} — marked failed.`;
}
