import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Store } from '../store/db.js';
import type { Manifest } from '../manifest/types.js';
import { resolveBaselineBranch } from '../manifest/baselineBranch.js';
import { isRunnable } from '../manifest/runnable.js';
import { startHot, type ServerRecord } from './supervisor.js';
import { serverLogPath } from './serverLog.js';
import { serviceLaunch } from './serviceLaunch.js';

interface RunningRow {
  id: number;
  pid: number;
  port: number;
  host: string;
  log_path: string;
  container: string | null;
}

/** Find a running baseline singleton (NULL ticket_id) for a service, if any. */
function findRunningBaseline(store: Store, service: string): ServerRecord | null {
  const row = store.db
    .prepare(
      `SELECT id, pid, port, host, log_path, container FROM servers
       WHERE repo = ? AND ticket_id IS NULL AND status = 'running'`,
    )
    .get(service) as RunningRow | undefined;
  if (!row) return null;
  return {
    id: row.id,
    ticketId: null,
    service,
    host: row.host,
    port: row.port,
    pid: row.pid,
    status: 'running',
    logPath: row.log_path,
    container: row.container,
  };
}

/**
 * Ensure a develop-branch checkout exists to serve the baseline from [H4] — never
 * serve baseline from whatever branch the main checkout happens to be on. A
 * dedicated, non-ticket worktree at `<repo>/.karst/baseline/<service>` on
 * `baselineBranch` is created once and reused.
 */
function ensureBaselineCheckout(repoPath: string, service: string, branch: string): string {
  const dir = join(repoPath, '.karst', 'baseline', service);
  if (!existsSync(dir)) {
    const r = spawnSync('git', ['worktree', 'add', '-q', '--force', dir, branch], {
      cwd: repoPath,
      encoding: 'utf8',
    });
    if (r.status !== 0) {
      throw new Error(`failed to create baseline checkout for ${service}: ${r.stderr}`);
    }
  }
  return dir;
}

/**
 * Acquire-if-not-running / reuse-if-running (§9). A baseline service is a lazy
 * singleton on its default port, served from `baselineBranch`, health-gated.
 * Never ticket-killed in MVP — lives with the daemon.
 */
export async function ensureBaseline(
  store: Store,
  manifest: Manifest,
  service: string,
): Promise<ServerRecord> {
  const existing = findRunningBaseline(store, service);
  if (existing) return existing; // reuse, no double-start

  const repo = manifest.repositories[service];
  if (!repo) throw new Error(`repository "${service}" not in manifest`);
  // Reachable only via a dependsOn edge, and `validateGraph` rejects an edge to a
  // non-runnable target — so this is a defensive throw, not a user-facing path.
  // It exists because the alternative (the old code) fabricated
  // `http://host:undefined/health` and health-gated against it.
  if (!isRunnable(repo)) {
    throw new Error(`repository "${service}" declares no service and cannot run as a baseline`);
  }
  const svc = repo.service;

  const httpSlot = svc.ports.find((p) => p.name === 'http') ?? svc.ports[0]!;
  const port = httpSlot.default;

  const checkout = ensureBaselineCheckout(
    repo.repoPath,
    service,
    resolveBaselineBranch(manifest, repo),
  );
  const env = { [httpSlot.env]: String(port) };
  // A baseline runs whatever kind of service the manifest declares — a command
  // or a container — through the same derivation spin uses, so the singleton can
  // never end up started one way and reaped another.
  const { command, args, container, healthUrl } = serviceLaunch({
    service: svc,
    name: service,
    ticketId: null,
    env,
    host: manifest.host,
    port,
    cwd: checkout,
  });

  return startHot(store, {
    ticketId: null, // baseline singleton
    service,
    command,
    args,
    container,
    cwd: checkout,
    env,
    host: manifest.host,
    port,
    healthUrl,
    requireIdentity: svc.healthIdentity === true,
    logPath: serverLogPath(checkout, `${service}.baseline`),
    repoPath: repo.repoPath,
  });
}

/**
 * Record a ref edge: this ticket depends on the baseline `service` (§9 ledger).
 * Informs "who'd be affected if you stopped this baseline". Idempotent (PK on
 * ticket+service).
 */
export function addBaselineRef(store: Store, ticketId: number, service: string): void {
  store.db
    .prepare(
      'INSERT OR IGNORE INTO baseline_refs (ticket_id, repo) VALUES (?, ?)',
    )
    .run(ticketId, service);
}
