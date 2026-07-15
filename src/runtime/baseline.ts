import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Store } from '../store/db.js';
import type { Manifest } from '../manifest/types.js';
import { startHot, type ServerRecord } from './supervisor.js';
import { renderHealthUrl } from './healthUrl.js';

interface RunningRow {
  id: number;
  pid: number;
  port: number;
  host: string;
  log_path: string;
}

/** Find a running baseline singleton (NULL ticket_id) for a service, if any. */
function findRunningBaseline(store: Store, service: string): ServerRecord | null {
  const row = store.db
    .prepare(
      `SELECT id, pid, port, host, log_path FROM servers
       WHERE service = ? AND ticket_id IS NULL AND status = 'running'`,
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

/** Split a `start` command string into command + args (simple whitespace split). */
function splitCommand(start: string): { command: string; args: string[] } {
  const parts = start.trim().split(/\s+/);
  return { command: parts[0]!, args: parts.slice(1) };
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

  const svc = manifest.services[service];
  if (!svc) throw new Error(`service "${service}" not in manifest`);

  const httpSlot = svc.ports.find((p) => p.name === 'http') ?? svc.ports[0]!;
  const port = httpSlot.default;

  const checkout = ensureBaselineCheckout(svc.repoPath, service, manifest.baselineBranch);
  const { command, args } = splitCommand(svc.start);

  const healthUrl = svc.health
    ? renderHealthUrl(svc.health, manifest.host, port)
    : `http://${manifest.host}:${port}/health`;

  return startHot(store, {
    ticketId: null, // baseline singleton
    service,
    command,
    args,
    cwd: checkout,
    env: { [httpSlot.env]: String(port) },
    host: manifest.host,
    port,
    healthUrl,
    logPath: join(checkout, `${service}.baseline.log`),
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
      'INSERT OR IGNORE INTO baseline_refs (ticket_id, service) VALUES (?, ?)',
    )
    .run(ticketId, service);
}
