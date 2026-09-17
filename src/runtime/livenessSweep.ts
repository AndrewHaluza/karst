import type { Store } from '../store/db.js';
import { markServerStopped } from './supervisor.js';
import { pidAlive } from './pidAlive.js';
import { connect } from 'node:net';

/**
 * Retire `running` server rows whose process is actually gone.
 *
 * The dashboard renders each row's `status` column verbatim, so a row that
 * claims `running` keeps claiming it until something re-derives the truth.
 * `reconcileOnStart` does that once, at activation — a VM suspend/resume that
 * kills the processes without restarting the extension host never runs it, and
 * the panel lies until the window is reloaded. This sweep is that same
 * attribution, run while the window is open.
 *
 * ALIVE means `pidAlive(pid)` OR the recorded `host:port` is not definitively
 * refused — a connection is accepted, or the probe could not answer in time.
 * The port check is required, not decorative: a launcher that
 * daemonises (`docker compose up -d`, `spawn(..., { detached: true }).unref()`)
 * exits and records its OWN pid while the process it left behind — in a group of
 * its own — keeps serving. Treating a dead pid alone as death would report a
 * live service offline on every pass. A bound port is evidence of life; absence
 * of a pid is not evidence of death. (This mirrors `bootSweeps.pidsStillServing`.)
 *
 * A retired row is MARKED, never deleted: `markServerStopped` flips it to
 * `stopped` and nulls the pid. A deleted row would vanish from the panel; a
 * retained `stopped` row comes back as offline and restartable, exactly as
 * `reconcileOnStart` leaves it. The row's `container` name is deliberately left
 * alone: this sweep NEVER tears a container down. A refused port is no proof a
 * container is dead — it may be running while its mapped port is not listening
 * — and `docker rm -f` would destroy a live workload irreversibly. Only the
 * explicit stop/reap paths remove containers; this module only observes and
 * records. Nothing here signals a process, so a false "alive" costs a stale row
 * until the next pass, whereas a false "dead" would flip a live service offline.
 *
 * A probe that throws or never answers leaves the row ALONE. Absence of evidence
 * is not evidence of death: a transient TCP error must not retire a row whose
 * process may still be running, so the per-row decision is isolated and an
 * unanswered probe is skipped rather than read as `false`.
 */

export interface RetiredServer {
  id: number;
  ticketId: number | null;
  service: string;
  pid: number | null;
}

export interface SweepLivenessOpts {
  /** Limit the sweep to one ticket's rows. Omit to sweep every running row. */
  ticketId?: number;
  /** Injected for tests. Defaults to the real probes. */
  isPidAlive?: (pid: number) => boolean;
  /**
   * Reachability of a recorded address, in three states: `true` (something
   * accepts connections), `false` (definitively refused), or `undefined` (no
   * answer in time — timeout / no route). `undefined` is NOT death, so the row
   * is left running. Defaults to the bounded tri-state probe below.
   */
  portOpen?: (host: string, port: number) => Promise<boolean | undefined>;
  debug?: (message: string) => void;
}

/**
 * A bounded TCP probe with three outcomes. `isPortOpen` deliberately folds
 * every failure into `false`: a port-conflict PREFLIGHT may read an unanswered
 * port as one it can try. A liveness sweep must not — a filtered port or an
 * overloaded host would then retire a healthy service. Only a definitive
 * `ECONNREFUSED` is evidence the listener is gone; a timeout is `undefined`.
 */
function probeReachable(
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
}

export async function sweepServerLiveness(
  store: Store,
  opts: SweepLivenessOpts = {},
): Promise<RetiredServer[]> {
  const isPidAlive = opts.isPidAlive ?? pidAlive;
  const portOpen = opts.portOpen ?? probeReachable;

  let sql = "SELECT id, ticket_id AS ticketId, repo, pid, host, port FROM servers WHERE status = 'running' AND kind = 'service'";
  const params: number[] = [];
  if (opts.ticketId !== undefined) {
    sql += ' AND ticket_id = ?';
    params.push(opts.ticketId);
  }

  const rows = store.db.prepare(sql).all(...params) as RunningServerRow[];
  const retired: RetiredServer[] = [];

  for (const row of rows) {
    try {
      if (row.pid != null && isPidAlive(row.pid)) continue;
      if (row.host !== null && row.port !== null) {
        // Only a DEFINITIVE refusal is death. `true` and `undefined` (a probe
        // that timed out) both keep the row: a filtered port must not retire a
        // live service.
        if ((await portOpen(row.host, row.port)) !== false) continue;
      }

      opts.debug?.(
        `[runtime] retiring server ${row.id} (${row.repo}, pid ${row.pid ?? 'unknown'}) — no live pid and nothing bound on ${row.host ?? '?'}:${row.port ?? '?'}`,
      );
      markServerStopped(store, row.id);
      retired.push({ id: row.id, ticketId: row.ticketId, service: row.repo, pid: row.pid });
    } catch (err) {
      opts.debug?.(
        `[runtime] liveness probe for server ${row.id} failed; leaving it running (${String(err)})`,
      );
      continue;
    }
  }

  return retired;
}

export function describeRetired(s: RetiredServer): string {
  return `karst: '${s.service}' is no longer running (pid ${s.pid ?? 'unknown'})` +
    `${s.ticketId === null ? '' : ` on ticket #${s.ticketId}`} — marked offline.`;
}
