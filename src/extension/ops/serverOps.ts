import type { Store } from '../../store/db.js';
import type { Manifest } from '../../manifest/types.js';
import type { Notify } from './notify.js';
import { stopServer } from '../../runtime/supervisor.js';
import { serverAddress } from '../../store/dashboard.js';
import {
  startTicketService,
  StartServiceError,
  type StartTicketServiceResult,
} from '../../runtime/startOne.js';
import { MissingAllocationError } from '../../resolver/recordedAllocator.js';
import { PortRangeExhaustedError } from '../../resolver/allocator.js';
import { stopSandboxService } from '../../agent/sandboxServices.js';
import { ticketSandboxContext, ticketSandboxRunner, type TicketSandboxDeps } from './sandboxTicketOps.js';

/**
 * The dashboard Servers panel's row-scoped operations, extracted from
 * `extension.ts` behind the `Notify` seam and explicit host callbacks. No
 * `vscode` import (enforced by `src/extension/ops/ratchet.test.ts`).
 *
 * `startServerRow` / `restartServerRow` start one already-spun service in its
 * existing worktree. A recorded ticket plays its ports back untouched; when the
 * target's allocation is missing (wiped by a teardown, or added to the manifest
 * after the spin) `startTicketService` recovers — a fresh port plus a restart of
 * every running dependent — and the toast names the new port and who was rewired.
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
  /** Sandboxed tickets (arch:AC-32): absent → every row is a host row, as before. */
  sandbox?: TicketSandboxDeps;
  /** arch:AC-32 decision 7: true while the agent UAT runs on this ticket's services. */
  userUatWithheld?: (ticketId: number) => boolean;
}

const WITHHELD = 'The agent UAT is still running on this service. Its link opens when the agent UAT finishes.';

/** The row's address, or null after a warning (gone, or withheld during agent UAT). */
function reachableAddress(deps: ServerOpsDeps, serverId: number): { host: string; port: number } | null {
  const addr = serverAddress(deps.store, serverId);
  if (!addr) {
    deps.notify.warn('That server is no longer running.');
    return null;
  }
  const row = deps.store.db.prepare('SELECT ticket_id AS ticketId FROM servers WHERE id = ?').get(serverId) as { ticketId: number | null } | undefined;
  if (row?.ticketId != null && deps.userUatWithheld?.(row.ticketId) === true) {
    deps.notify.warn(WITHHELD);
    return null;
  }
  return addr;
}

/**
 * Stop one row. A sandboxed row (`servers.sandbox`) has no host pid: it is
 * stopped inside its sandbox and its 127.0.0.1 mapping removed. When its
 * runner is gone (backend changed), the row is still retired on the host side.
 */
async function stopRow(deps: ServerOpsDeps, serverId: number): Promise<void> {
  const row = deps.store.db
    .prepare('SELECT ticket_id AS ticketId, sandbox FROM servers WHERE id = ?')
    .get(serverId) as { ticketId: number | null; sandbox: string | null } | undefined;
  const found = row?.sandbox && row.ticketId !== null && deps.sandbox ? ticketSandboxRunner(deps.sandbox, row.ticketId) : undefined;
  if (found) {
    await stopSandboxService(deps.store, serverId, found.runner);
    return;
  }
  await stopServer(deps.store, serverId);
}

export async function stopServerRow(deps: ServerOpsDeps, serverId: number): Promise<void> {
  await stopRow(deps, serverId);
  deps.afterServerChange();
}

export function openServerRow(deps: ServerOpsDeps, serverId: number): void {
  const addr = reachableAddress(deps, serverId);
  if (!addr) return;
  deps.openExternal(`http://${addr.host}:${addr.port}`);
}

export function copyServerUrlRow(deps: ServerOpsDeps, serverId: number): void {
  const addr = reachableAddress(deps, serverId);
  if (!addr) return;
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
    if (stopFirst) await stopRow(deps, serverId);
    const sandbox = deps.sandbox ? await ticketSandboxContext(deps.sandbox, row.ticketId) : undefined;
    const result = await startTicketService(deps.store, manifest, row.ticketId, repo, {
      debug: deps.debug,
      ...(sandbox ? { sandbox } : {}),
    });
    deps.notify.info(startMessage(verb, repo, result));
  } catch (err) {
    if (err instanceof MissingAllocationError) {
      throw new Error(
        `Cannot start ${repo}: its ports are no longer recorded. Re-spin the ticket to restart it.`,
      );
    }
    if (err instanceof PortRangeExhaustedError) {
      throw new Error(
        `Cannot start ${repo}: ${err.message}. Free a port or widen the range, then try again.`,
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

/**
 * The row-start toast. A recorded start says so plainly; a recovery names the
 * new port and the dependents restarted to pick it up, so silent miswiring is
 * impossible to miss.
 */
function startMessage(
  verb: 'Started' | 'Restarted',
  repo: string,
  result: StartTicketServiceResult,
): string {
  const ports = Object.values(result.newPorts);
  if (ports.length === 0) return `${verb} ${repo}.`;
  const rewired =
    result.restartedDependents.length > 0
      ? `; restarted ${result.restartedDependents.join(', ')} to rewire.`
      : '.';
  const label = ports.length > 1 ? 'new ports' : 'new port';
  return `${verb} ${repo} on :${ports.join(', :')} (${label})${rewired}`;
}
