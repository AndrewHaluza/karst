import type { Store } from '../../store/db.js';
import type { Manifest } from '../../manifest/types.js';
import type { Notify } from './notify.js';
import { stopServer } from '../../runtime/supervisor.js';
import { serverAddress } from '../../store/dashboard.js';
import { startTicketService, StartServiceError } from '../../runtime/startOne.js';
import { MissingAllocationError } from '../../resolver/recordedAllocator.js';

/**
 * The dashboard Servers panel's row-scoped operations, extracted from
 * `extension.ts` behind the `Notify` seam and explicit host callbacks. No
 * `vscode` import (enforced by `src/extension/ops/ratchet.test.ts`).
 *
 * `startServerRow` / `restartServerRow` start exactly one already-spun service
 * in its existing worktree on its existing ports (`startTicketService`). They
 * are not a re-spin: peers and ports are untouched, and a missing allocation
 * tells the user to re-spin rather than silently re-porting one service.
 */
export interface ServerOpsDeps {
  store: Store;
  notify: Notify;
  /** Repaint the dashboard + tree after a row changed. */
  afterServerChange: () => void;
  /** The loaded manifest, or null when none could be resolved. */
  loadManifest: () => Promise<Manifest | null>;
  /** Open an external URL (bound to `vscode.env.openExternal`). */
  openExternal: (url: string) => void;
  /** Write to the clipboard (bound to `vscode.env.clipboard.writeText`). */
  copyText: (text: string) => void;
  debug: (message: string) => void;
}

export async function stopServerRow(deps: ServerOpsDeps, serverId: number): Promise<void> {
  await stopServer(deps.store, serverId);
  deps.afterServerChange();
}

export function openServerRow(deps: ServerOpsDeps, serverId: number): void {
  const addr = serverAddress(deps.store, serverId);
  if (!addr) {
    deps.notify.warn('That server is no longer running.');
    return;
  }
  deps.openExternal(`http://${addr.host}:${addr.port}`);
}

export function copyServerUrlRow(deps: ServerOpsDeps, serverId: number): void {
  const addr = serverAddress(deps.store, serverId);
  if (!addr) {
    deps.notify.warn('That server is no longer running.');
    return;
  }
  deps.copyText(`http://${addr.host}:${addr.port}`);
}

export async function startServerRow(deps: ServerOpsDeps, serverId: number): Promise<void> {
  await runStart(deps, serverId, 'Started', false);
}

export async function restartServerRow(deps: ServerOpsDeps, serverId: number): Promise<void> {
  await runStart(deps, serverId, 'Restarted', true);
}

/**
 * Shared start body for the two row-start verbs. Validates the row, loads the
 * manifest, optionally stops the row first (Restart), then starts only that
 * repo. A failure REJECTS with a user-facing message: the dashboard dispatch
 * seam turns a rejection into `action-result { ok: false, message }`, which is
 * how the webview's pending control learns the action failed (and shows the
 * reason) instead of flashing success. `afterServerChange` runs in `finally` so
 * the row repaints whether the start succeeded or failed.
 */
async function runStart(
  deps: ServerOpsDeps,
  serverId: number,
  verb: 'Started' | 'Restarted',
  stopFirst: boolean,
): Promise<void> {
  const row = deps.store.db
    .prepare('SELECT ticket_id AS ticketId, repo FROM servers WHERE id = ?')
    .get(serverId) as { ticketId: number | null; repo: string } | undefined;
  if (!row) throw new Error('That server row no longer exists.');
  if (row.ticketId === null) {
    throw new Error('Baseline services cannot be started from a ticket dashboard.');
  }
  const repo = row.repo;

  const manifest = await deps.loadManifest();
  if (!manifest) return;

  try {
    if (stopFirst) await stopServer(deps.store, serverId);
    await startTicketService(deps.store, manifest, row.ticketId, repo, { debug: deps.debug });
    deps.notify.info(`${verb} ${repo}.`);
  } catch (err) {
    if (err instanceof MissingAllocationError) {
      throw new Error(
        `Cannot start ${repo}: its ports are no longer recorded. Re-spin the ticket to restart it.`,
      );
    }
    if (err instanceof StartServiceError) throw err;
    throw new Error(
      `Failed to start ${repo}: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    deps.afterServerChange();
  }
}
