import type { Store } from '../../store/db.js';
import type { Manifest } from '../../manifest/types.js';
import { listProjectServers } from '../../store/serverInventory.js';
import type { ServersHost } from '../../ui/resources/panel.js';
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
  openTicketLogs: (ticketId: number) => void;
  openLogs: () => void;
}

export function makeServersHost(deps: ServersHostDeps): ServersHost {
  return {
    inventory: () => {
      const projectId = deps.projectId();
      const manifest = deps.manifest();
      if (projectId === undefined || !manifest) return undefined;
      return listProjectServers(deps.store, manifest, projectId);
    },
    startShared: (repo) => startShared(deps.shared, repo),
    restartShared: (repo) => restartShared(deps.shared, repo),
    stopShared: (repo) => stopShared(deps.shared, repo),
    setPinned: (repo, pinned) => setPinned(deps.shared, repo, pinned),
    stopIdle: async () => void (await stopIdle(deps.shared)),
    startRow: (id) => startServerRow(deps.rows, id),
    restartRow: (id) => restartServerRow(deps.rows, id),
    stopRow: (id) => stopServerRow(deps.rows, id),
    openRow: (id) => openServerRow(deps.rows, id),
    copyRow: (id) => copyServerUrlRow(deps.rows, id),
    stopTicket: async (ticketId) => {
      await deps.stopTicketServers(ticketId);
      deps.rows.afterServerChange();
    },
    openTicketLogs: deps.openTicketLogs,
    openLogs: deps.openLogs,
  };
}
