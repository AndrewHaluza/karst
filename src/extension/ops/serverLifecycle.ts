import type { Store } from '../../store/db.js';
import type { Manifest, StopServersOnDone } from '../../manifest/types.js';
import type { Notify } from './notify.js';
import { getTicket, setTicketServersOnDone } from '../../store/tickets.js';
import { plural, reasonText } from '../../model/notifyText.js';
import { ticketToastLabel } from '../ticketToastLabel.js';

export interface ServerLifecycleDeps {
  readonly store: Store;
  readonly manifest: () => Manifest | undefined;
  /** Stop seam: (store, id) => sandboxB ? sandboxB.stopTicket(store, id) : stopTicketServers(store, id) */
  readonly stopServers: (store: Store, ticketId: number) => Promise<void>;
  readonly notify: Notify;
  readonly writeManifest?: (path: string, manifest: Manifest) => void;
  readonly manifestPath?: () => string | undefined;
  readonly logError?: (message: string, error?: unknown) => void;
  readonly afterServerChange?: () => void;
}

export interface RunningServerRow {
  readonly id: number;
  readonly repo: string;
}

/** Read running ticket services (`ticket_id = ? AND status = 'running' AND kind = 'service'`). */
export function listRunningTicketServices(store: Store, ticketId: number): RunningServerRow[] {
  return store.db
    .prepare(
      "SELECT id, repo FROM servers WHERE ticket_id = ? AND status = 'running' AND kind = 'service'",
    )
    .all(ticketId) as RunningServerRow[];
}

export const STOP_SERVERS_ACTION = 'Stop servers';
export const KEEP_SERVERS_ACTION = 'Keep servers running';
export const ALWAYS_STOP_SERVERS_ACTION = 'Always stop servers';
export const SERVERS_ON_DONE_ACTIONS = [STOP_SERVERS_ACTION, KEEP_SERVERS_ACTION, ALWAYS_STOP_SERVERS_ACTION] as const;

async function stopTicketServices(deps: ServerLifecycleDeps, ticketId: number): Promise<boolean> {
  try {
    await deps.stopServers(deps.store, ticketId);
    deps.afterServerChange?.();
    return true;
  } catch (err) {
    deps.logError?.(`karst: stopping servers for ticket ${ticketId} failed`, err);
    await deps.notify.error(`${ticketToastLabel(deps.store, ticketId)}: the servers did not stop (${reasonText(err)}).`);
    return false;
  }
}

/**
 * Handle running servers for a ticket transitioning to done according to the
 * project's `stopServersOnDone` setting ('ask' default | 'auto' | 'off').
 */
export async function maybeStopServersOnDone(
  deps: ServerLifecycleDeps,
  ticketId: number,
): Promise<void> {
  const ticket = getTicket(deps.store, ticketId);
  // Idempotency guard: if already recorded for this ticket, do not prompt or act again.
  if (ticket.serversOnDone !== null) {
    return;
  }

  const running = listRunningTicketServices(deps.store, ticketId);
  // None running -> no-op.
  if (running.length === 0) {
    return;
  }

  const manifest = deps.manifest();
  const setting: StopServersOnDone = manifest?.stopServersOnDone ?? 'ask';

  // off -> no-op.
  if (setting === 'off') {
    setTicketServersOnDone(deps.store, ticketId, 'off');
    return;
  }

  // auto -> stop without asking and announce it.
  if (setting === 'auto') {
    setTicketServersOnDone(deps.store, ticketId, 'auto');
    const ok = await stopTicketServices(deps, ticketId);
    if (!ok) {
      return;
    }
    // A routine background event (@arch:NTF-05): the row is recorded, no toast.
    deps.notify.record?.('info', `${ticketToastLabel(deps.store, ticketId)}: stopped ${plural(running.length, 'server', 'servers')} because the ticket is done.`, ticketId);
    return;
  }

  if (setting !== 'ask') {
    return;
  }

  // ask (default) -> if not yet asked, show ONE non-modal information message with the three actions.
  const count = running.length;
  const message = `${ticketToastLabel(deps.store, ticket.id)} is done. ${plural(count, 'server is', 'servers are')} still running.`;

  const choice = deps.notify.infoActions
    ? await deps.notify.infoActions(message, SERVERS_ON_DONE_ACTIONS)
    : undefined;

  // Dismissal: records 'asked' and does not re-prompt; servers stay running.
  if (!choice) {
    setTicketServersOnDone(deps.store, ticketId, 'asked');
    return;
  }

  if (choice === KEEP_SERVERS_ACTION) {
    setTicketServersOnDone(deps.store, ticketId, 'kept');
    return;
  }

  if (choice === STOP_SERVERS_ACTION) {
    setTicketServersOnDone(deps.store, ticketId, 'stopped');
    await stopTicketServices(deps, ticketId);
    return;
  }

  if (choice === ALWAYS_STOP_SERVERS_ACTION) {
    setTicketServersOnDone(deps.store, ticketId, 'stopped');
    try {
      if (deps.writeManifest && deps.manifestPath) {
        const path = deps.manifestPath();
        const current = deps.manifest();
        if (path) {
          if (!current) {
            throw new Error('cannot write stopServersOnDone: manifest is not loaded');
          }
          deps.writeManifest(path, { ...current, stopServersOnDone: 'auto' });
          deps.notify.info('Karst stops the servers of a done ticket without asking from now on.');
        }
      }
    } catch (err) {
      deps.logError?.('karst: writing stopServersOnDone: auto to manifest failed', err);
      await deps.notify.error(`The setting was not saved to the manifest (${reasonText(err)}). The servers of this ticket still stop now.`);
    }
    await stopTicketServices(deps, ticketId);
    return;
  }
}
