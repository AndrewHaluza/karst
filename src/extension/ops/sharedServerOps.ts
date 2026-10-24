import type { Store } from '../../store/db.js';
import type { Manifest } from '../../manifest/types.js';
import type { Notify } from './notify.js';
import { unitByKey } from '../../manifest/runnable.js';
import { pinBaseline, unpinBaseline } from '../../store/baselinePins.js';
import { listSharedServers, type SharedServer } from '../../store/serverInventory.js';
import { formatId } from '../../model/entityId.js';

/**
 * The Servers panel's verbs on SHARED (baseline) services, extracted behind the
 * `Notify` seam and explicit host callbacks. No `vscode` import (enforced by
 * `ops/ratchet.test.ts`).
 *
 * A shared service is addressed by its unit key, never by a `servers.id`:
 * `startHot` deletes and reinserts the row on every start, so an id from the
 * last render may already be gone. Every verb re-reads the row fresh, and a
 * failure REJECTS with a user-facing message — the panel's dispatch seam turns
 * that into `action-result { ok: false }`, which is how the pending control
 * learns the verb did not happen.
 *
 * A baseline's port is its default and does not move, so dependents are not
 * re-wired by a stop or restart; the ticket group's `dependencyDown` badge
 * tells the truth after a stop.
 */
export interface SharedServerOpsDeps {
  store: Store;
  notify: Notify;
  /** The loaded manifest, or null when none could be resolved. */
  loadManifest: () => Promise<Manifest | null>;
  /** Acquire-if-not-running (`runtime/baseline.ts`). */
  ensureBaseline: (store: Store, manifest: Manifest, service: string) => Promise<unknown>;
  /** The attributed stop (`runtime/supervisor.ts`); it can leave a refused row running. */
  stopServer: (store: Store, serverId: number) => Promise<void>;
  /** Host-side confirmation (UI-R33). `actionLabel` names the modal's confirm button. */
  confirm: (message: string, actionLabel: string) => Promise<boolean>;
  /** Repaint every surface that shows servers. */
  afterServerChange: () => void;
}

export interface StopIdleResult {
  stopped: string[];
  failed: Array<{ repo: string; reason: string }>;
}

async function requireManifest(deps: SharedServerOpsDeps): Promise<Manifest> {
  const manifest = await deps.loadManifest();
  if (!manifest) throw new Error('No karst.yml could be loaded for this project.');
  return manifest;
}

function find(deps: SharedServerOpsDeps, manifest: Manifest, repo: string): SharedServer | undefined {
  return listSharedServers(deps.store, manifest).find((s) => s.repo === repo);
}

/** Names the user can match against their board; a done ticket says why it still counts. */
function dependentLabels(server: SharedServer): string[] {
  return server.dependents.map((d) => {
    const key = d.key ?? formatId('ticket', d.ticketId);
    return d.done ? `${key} (done, still running)` : key;
  });
}

function impactSentence(server: SharedServer): string {
  const labels = dependentLabels(server);
  return labels.length === 0
    ? 'No live ticket depends on it.'
    : `${labels.length} live ticket(s) depend on it: ${labels.join(', ')}.`;
}

/** Run the attributed stop, then refuse to claim success if the row still says running. */
async function stopAndVerify(deps: SharedServerOpsDeps, server: SharedServer): Promise<void> {
  await deps.stopServer(deps.store, server.id);
  const row = deps.store.db.prepare('SELECT status FROM servers WHERE id = ?').get(server.id) as
    | { status: string }
    | undefined;
  if (row?.status === 'running') {
    throw new Error(`${server.repo} was not stopped — its process is still running.`);
  }
}

/** Manual Start from the panel: acquire the baseline, then keep it warm (pin). */
export async function startShared(deps: SharedServerOpsDeps, repo: string): Promise<void> {
  const manifest = await requireManifest(deps);
  if (!unitByKey(manifest, repo)) {
    throw new Error(`"${repo}" is not a service declared in karst.yml.`);
  }
  try {
    await deps.ensureBaseline(deps.store, manifest, repo);
    pinBaseline(deps.store, repo);
    deps.notify.info(`Started ${repo} and kept it running.`);
  } catch (err) {
    throw new Error(`Failed to start ${repo}: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    deps.afterServerChange();
  }
}

/** Stop then start; the pin is neither added nor dropped — a restart is not a decision to keep or release. */
export async function restartShared(deps: SharedServerOpsDeps, repo: string): Promise<void> {
  const manifest = await requireManifest(deps);
  const server = find(deps, manifest, repo);
  if (!server || server.status !== 'running') {
    throw new Error(`${repo} is not running, so it cannot be restarted. Start it instead.`);
  }
  const ok = await deps.confirm(
    `Restart shared service "${repo}"? ${impactSentence(server)} It is down while it restarts; ` +
      `the same port is reused, so nothing is re-wired.`,
    'Restart',
  );
  if (!ok) return;
  try {
    await stopAndVerify(deps, server);
    await deps.ensureBaseline(deps.store, manifest, repo);
    deps.notify.info(`Restarted ${repo}.`);
  } finally {
    deps.afterServerChange();
  }
}

/** Explicit Stop: confirm, stop, and release the keep-warm pin. */
export async function stopShared(deps: SharedServerOpsDeps, repo: string): Promise<void> {
  const manifest = await requireManifest(deps);
  const server = find(deps, manifest, repo);
  if (!server || server.status !== 'running') {
    throw new Error(`${repo} is not running.`);
  }
  const ok = await deps.confirm(
    `Stop shared service "${repo}"? ${impactSentence(server)} Stopping it takes the dependency ` +
      `out from under them; they are not re-wired.`,
    'Stop service',
  );
  if (!ok) return;
  try {
    await stopAndVerify(deps, server);
    unpinBaseline(deps.store, repo);
    deps.notify.info(`Stopped ${repo}.`);
  } finally {
    deps.afterServerChange();
  }
}

/** Pin or unpin without touching the process. */
export function setPinned(deps: SharedServerOpsDeps, repo: string, pinned: boolean): void {
  if (pinned) pinBaseline(deps.store, repo);
  else unpinBaseline(deps.store, repo);
  deps.afterServerChange();
}

/**
 * The shared services Stop idle would stop: running, zero live dependents, no
 * pin. Exported so the panel's state can show the same set it will act on.
 */
export function idleShared(shared: readonly SharedServer[]): SharedServer[] {
  return shared.filter((s) => s.status === 'running' && s.dependents.length === 0 && !s.pinned);
}

/**
 * Stop every idle shared service behind ONE host confirmation naming them. Each
 * is stopped through the attributed path in isolation; the outcome reports how
 * many stopped and names every failure (a partial failure rejects).
 */
export async function stopIdle(deps: SharedServerOpsDeps): Promise<StopIdleResult> {
  const manifest = await requireManifest(deps);
  const idle = idleShared(listSharedServers(deps.store, manifest));
  const result: StopIdleResult = { stopped: [], failed: [] };
  if (idle.length === 0) {
    deps.notify.info('No idle shared services to stop.');
    return result;
  }
  const names = idle.map((s) => s.repo);
  const ok = await deps.confirm(
    `Stop ${names.length} idle shared service(s): ${names.join(', ')}? ` +
      `No live ticket depends on them and none is kept running.`,
    'Stop idle',
  );
  if (!ok) return result;
  try {
    for (const server of idle) {
      try {
        await stopAndVerify(deps, server);
        result.stopped.push(server.repo);
      } catch (err) {
        result.failed.push({ repo: server.repo, reason: err instanceof Error ? err.message : String(err) });
      }
    }
  } finally {
    deps.afterServerChange();
  }
  if (result.failed.length > 0) {
    const failed = result.failed.map((f) => `${f.repo} (${f.reason})`).join('; ');
    throw new Error(`Stopped ${result.stopped.length} of ${idle.length}. Not stopped: ${failed}`);
  }
  deps.notify.info(`Stopped ${result.stopped.length} idle shared service(s): ${result.stopped.join(', ')}.`);
  return result;
}
