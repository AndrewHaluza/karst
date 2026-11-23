import type { Store } from '../../store/db.js';
import type { Manifest } from '../../manifest/types.js';
import { listProjectServers } from '../../store/serverInventory.js';
import type { InventoryServer } from '../../store/serverInventory.js';
import type { ServersHost } from '../../ui/resources/panel.js';
import type { ServersViewHints, TransientStatus } from '../../ui/resources/serversState.js';
import { serviceUnits } from '../../manifest/runnable.js';
import { healthTimeoutMsOf } from '../../runtime/healthTimeout.js';
import { plural } from '../../model/notifyText.js';
import { formatId } from '../../model/entityId.js';
import { SERVER_VERB_LABEL } from '../../model/serverStatusText.js';
import {
  restartShared,
  setPinned,
  startShared,
  stopIdle,
  stopShared,
  type SharedServerOpsDeps,
} from './sharedServerOps.js';
import {
  copyServerUrlRow,
  openServerRow,
  restartServerRow,
  startServerRow,
  stopServerRow,
  type ServerOpsDeps,
} from './serverOps.js';

/**
 * Binds the Servers tab's `ServersHost` to the ops that already exist: shared
 * verbs from `sharedServerOps`, ticket-row verbs from `serverOps` (the same
 * ones the dashboard uses, so the sandbox path and the "withheld during agent
 * UAT" rule apply unchanged). No `vscode` import (see `ops/ratchet.test.ts`).
 */
export interface ServersHostDeps {
  store: Store;
  /** The current project, or undefined when none is open. */
  projectId: () => number | undefined;
  /** The loaded manifest (sync — the inventory read cannot await). */
  manifest: () => Manifest | undefined;
  shared: SharedServerOpsDeps;
  rows: ServerOpsDeps;
  /** Stop every running service of a ticket (sandbox-aware in the host binding). */
  stopTicketServers: (ticketId: number) => Promise<void>;
  /** One liveness sweep (`livenessLoop.sweepNow`), single-flight. */
  sweepNow: () => Promise<void>;
  openTicketLogs: (ticketId: number) => void;
  /** Open the shared services' combined log (no ticket scope). */
  openSharedLogs: () => void;
  openLogs: () => void;
}

const UAT_STOPS_TOO = ' The agent UAT on this ticket stops too.';

/**
 * Run `op` with `status` on every key, and clear the keys in `finally`. The
 * keys are set synchronously, so a repaint posted right after the call shows them.
 */
function holding<K>(map: Map<K, TransientStatus>, keys: readonly K[], status: TransientStatus, op: () => Promise<void>): Promise<void> {
  for (const key of keys) map.set(key, status);
  const clear = (): void => {
    for (const key of keys) map.delete(key);
  };
  let run: Promise<void>;
  try {
    run = op();
  } catch (err) {
    clear();
    return Promise.reject(err);
  }
  return run.finally(clear);
}

export function makeServersHost(deps: ServersHostDeps): ServersHost {
  // The verbs in flight. The host owns them (the webview decides nothing): the
  // row shows "Starting…" / "Stopping…" until the op settles, win or lose.
  const rowVerbs = new Map<number, TransientStatus>();
  const sharedVerbs = new Map<string, TransientStatus>();
  const inventory: ServersHost['inventory'] = () => {
    const projectId = deps.projectId();
    const manifest = deps.manifest();
    if (projectId === undefined || !manifest) return undefined;
    return listProjectServers(deps.store, manifest, projectId);
  };
  const startBudgetMs = (service: string): number | undefined => {
    const manifest = deps.manifest();
    const unit = manifest ? serviceUnits(manifest).find((u) => u.key === service) : undefined;
    return unit ? healthTimeoutMsOf(unit.def) : undefined;
  };
  /** The row the verb names, read fresh: the copy verb needs the row's health kind. */
  const rowOf = (serverId: number): InventoryServer | undefined => {
    const inv = inventory();
    if (!inv) return undefined;
    return (
      inv.shared.find((r) => r.id === serverId) ??
      inv.tickets.flatMap((g) => g.servers).find((r) => r.id === serverId)
    );
  };
  const stopTicket = async (ticketId: number): Promise<void> => {
    const group = inventory()?.tickets.find((g) => g.ticketId === ticketId);
    const running = group ? group.servers.filter((r) => r.status === 'running') : [];
    const key = group?.key ?? formatId('ticket', ticketId);
    const names = running.map((r) => r.repo).join(', ');
    const withheld = deps.rows.userUatWithheld?.(ticketId) === true;
    const message =
      `Stop the ${plural(running.length, 'server', 'servers')} of ${key} (${names})?` +
      (withheld ? UAT_STOPS_TOO : '');
    if (!(await deps.shared.confirm(message, SERVER_VERB_LABEL.stopServers))) return;
    await holding(rowVerbs, running.map((r) => r.id), 'stopping', () => deps.stopTicketServers(ticketId));
    deps.rows.afterServerChange();
  };
  return {
    inventory,
    viewHints: (): ServersViewHints => ({ rowVerbs, sharedVerbs, startBudgetMs }),
    sweep: () => deps.sweepNow(),
    startShared: (repo) => holding(sharedVerbs, [repo], 'starting', () => startShared(deps.shared, repo)),
    restartShared: (repo) => holding(sharedVerbs, [repo], 'starting', () => restartShared(deps.shared, repo)),
    stopShared: (repo) => holding(sharedVerbs, [repo], 'stopping', () => stopShared(deps.shared, repo)),
    setPinned: (repo, pinned) => setPinned(deps.shared, repo, pinned),
    stopIdle: async () => void (await stopIdle(deps.shared)),
    startRow: (id) => holding(rowVerbs, [id], 'starting', () => startServerRow(deps.rows, id)),
    restartRow: (id) => holding(rowVerbs, [id], 'starting', () => restartServerRow(deps.rows, id)),
    stopRow: (id) => holding(rowVerbs, [id], 'stopping', () => stopServerRow(deps.rows, id)),
    openRow: (id) => openServerRow(deps.rows, id),
    copyRow: (id) => copyServerUrlRow(deps.rows, id, rowOf(id)?.httpHealth),
    stopTicket,
    openTicketLogs: deps.openTicketLogs,
    openSharedLogs: deps.openSharedLogs,
    openLogs: deps.openLogs,
  };
}
