import type { InventoryServer, ServerInventory, SharedServer } from '../../store/serverInventory.js';
import { formatId } from '../../model/entityId.js';

/**
 * The Servers tab's read model.
 *
 * Like `state.ts`, every display string is produced HERE, host-side (UI-R31):
 * the webview only escapes and lays out. An absent fact renders `''`, never a
 * placeholder that could read as a measured value. The webview decides nothing —
 * which verbs a row offers, whether Stop idle is available and why not are all
 * facts of this model.
 */

export type ServerStatus = 'running' | 'stopped' | 'failed';

/** Word shown next to the status shape (UI-R28: never shape or colour alone). */
export const STATUS_LABEL: Record<ServerStatus, string> = {
  running: 'Running',
  stopped: 'Stopped',
  failed: 'Failed',
};

export interface ServerRowView {
  serverId: number;
  /** The unit key (`api`, `api/web`). */
  service: string;
  status: ServerStatus;
  statusLabel: string;
  /** `localhost:3000` while running, else `''`. */
  address: string;
  /** Whether Open / Copy apply (running with a known address). */
  reachable: boolean;
}

export interface DependentView {
  label: string;
  done: boolean;
}

export interface SharedRowView extends ServerRowView {
  baseBranch: string;
  pinned: boolean;
  /** Pinned AND running — labelled "kept running", never offered to Stop idle. */
  keptRunning: boolean;
  dependents: DependentView[];
  /** Running with no live dependent and no pin — what Stop idle would stop. */
  idle: boolean;
}

export interface TicketGroupView {
  ticketId: number;
  key: string;
  title: string;
  stage: string;
  running: number;
  total: number;
  /** Finished ticket whose servers still run. */
  doneStillRunning: boolean;
  /** Archived ticket whose servers still run — leftovers to clean up. */
  cleanUp: boolean;
  /** Unit keys of the shared services this ticket needs that are not running. */
  downServices: string[];
  servers: ServerRowView[];
}

export interface ServersSummary {
  runningTickets: number;
  runningShared: number;
  idleShared: number;
  finishedWithRunning: number;
}

export interface StopIdleView {
  count: number;
  names: string[];
  /** Why the control is disabled (UI-R17); `null` when it is available. */
  disabledReason: string | null;
}

export type ServersEmpty = 'none' | 'shared-only' | 'tickets-only' | null;

export interface ServersState {
  /** False when there is no project or manifest to read (nothing is guessed). */
  available: boolean;
  unavailableReason: string;
  scopeLabel: string;
  summary: ServersSummary;
  shared: SharedRowView[];
  groups: TicketGroupView[];
  stopIdle: StopIdleView;
  empty: ServersEmpty;
}

const NO_IDLE_REASON = 'No idle shared service: every running one has a live ticket or is kept running.';
const NOTHING_RUNNING_REASON = 'No shared service is running.';

const EMPTY_SUMMARY: ServersSummary = {
  runningTickets: 0,
  runningShared: 0,
  idleShared: 0,
  finishedWithRunning: 0,
};

export function unavailableServersState(reason: string, scopeLabel = ''): ServersState {
  return {
    available: false,
    unavailableReason: reason,
    scopeLabel,
    summary: EMPTY_SUMMARY,
    shared: [],
    groups: [],
    stopIdle: { count: 0, names: [], disabledReason: reason },
    empty: null,
  };
}

function statusOf(row: InventoryServer): ServerStatus {
  return row.status === 'running' ? 'running' : row.status === 'failed' ? 'failed' : 'stopped';
}

function rowView(row: InventoryServer): ServerRowView {
  const status = statusOf(row);
  const reachable = status === 'running' && row.host !== null && row.port !== null;
  return {
    serverId: row.id,
    service: row.repo,
    status,
    statusLabel: STATUS_LABEL[status],
    address: reachable ? `${row.host}:${row.port}` : '',
    reachable,
  };
}

function sharedView(row: SharedServer): SharedRowView {
  const base = rowView(row);
  const running = base.status === 'running';
  return {
    ...base,
    baseBranch: row.baseBranch ?? '',
    pinned: row.pinned,
    keptRunning: row.pinned && running,
    dependents: row.dependents.map((d) => ({
      label: d.key ?? formatId('ticket', d.ticketId),
      done: d.done,
    })),
    idle: running && row.dependents.length === 0 && !row.pinned,
  };
}

export function buildServersState(inventory: ServerInventory, scopeLabel: string): ServersState {
  const shared = inventory.shared.map(sharedView);
  const groups = inventory.tickets.map((g): TicketGroupView => {
    const servers = g.servers.map(rowView);
    const running = servers.filter((s) => s.status === 'running').length;
    return {
      ticketId: g.ticketId,
      key: g.key ?? formatId('ticket', g.ticketId),
      title: g.title ?? '',
      stage: g.stage ?? '',
      running,
      total: servers.length,
      doneStillRunning: g.done && !g.archived && running > 0,
      cleanUp: g.archived && running > 0,
      downServices: g.downServices,
      servers,
    };
  });
  const idle = shared.filter((s) => s.idle);
  const runningShared = shared.filter((s) => s.status === 'running').length;
  const disabledReason =
    idle.length > 0 ? null : runningShared === 0 ? NOTHING_RUNNING_REASON : NO_IDLE_REASON;
  return {
    available: true,
    unavailableReason: '',
    scopeLabel,
    summary: {
      runningTickets: groups.reduce((n, g) => n + g.running, 0),
      runningShared,
      idleShared: idle.length,
      finishedWithRunning: groups.filter((g) => g.doneStillRunning).length,
    },
    shared,
    groups,
    stopIdle: { count: idle.length, names: idle.map((s) => s.service), disabledReason },
    empty:
      shared.length === 0 && groups.length === 0
        ? 'none'
        : groups.length === 0
          ? 'shared-only'
          : shared.length === 0
            ? 'tickets-only'
            : null,
  };
}
