import type { InventoryServer, ServerInventory, SharedServer } from '../../store/serverInventory.js';
import { formatId } from '../../model/entityId.js';
import { SERVER_STATUS_WORD } from '../../model/serverStatusText.js';
import { HEALTH_TIMEOUT_DEFAULT_MS } from '../../runtime/health.js';

/**
 * The Servers tab's read model.
 *
 * Like `state.ts`, every display string is produced HERE, host-side (UI-R31):
 * the webview only escapes and lays out. An absent fact renders `''`, never a
 * placeholder that could read as a measured value. The webview decides nothing —
 * which verbs a row offers, whether Stop idle is available and why not are all
 * facts of this model.
 */

/**
 * `starting` and `stopping` are transient: the host holds them while a verb runs
 * on the row (`ServersViewHints`). A crash is `failed` with a `reason`.
 */
export type ServerStatus = 'running' | 'starting' | 'stopping' | 'stopped' | 'failed';

/** The transient states a host verb puts on a row while it runs. */
export type TransientStatus = 'starting' | 'stopping';

/** Word shown next to the status shape (UI-R28: never shape or colour alone). */
export const STATUS_LABEL: Readonly<Record<ServerStatus, string>> = {
  running: SERVER_STATUS_WORD.running,
  starting: SERVER_STATUS_WORD.starting,
  stopping: SERVER_STATUS_WORD.stopping,
  stopped: SERVER_STATUS_WORD.stopped,
  failed: SERVER_STATUS_WORD.failed,
};

/** The start budget of a row with no declared `healthTimeoutSeconds`. */
export const DEFAULT_START_BUDGET_MS = HEALTH_TIMEOUT_DEFAULT_MS;

/** Host facts that are not in the inventory: the verbs in flight and the start budgets. */
export interface ServersViewHints {
  /** Ticket rows with a verb in flight, by `servers.id`. */
  rowVerbs?: ReadonlyMap<number, TransientStatus>;
  /** Shared rows with a verb in flight, by unit key. */
  sharedVerbs?: ReadonlyMap<string, TransientStatus>;
  /** The declared health budget of a unit in ms; undefined → the default. */
  startBudgetMs?: (service: string) => number | undefined;
}

export interface ServerRowView {
  serverId: number;
  /** The unit key (`api`, `api/web`). */
  service: string;
  status: ServerStatus;
  statusLabel: string;
  /** `localhost:3000` while running, else `''`. */
  address: string;
  /** Whether Copy applies (running with a known address). */
  reachable: boolean;
  /** Whether Open applies: reachable AND the health check speaks HTTP. */
  openable: boolean;
  /** Why a `failed` row failed (`servers.last_error`), else `''`. */
  reason: string;
  /** `localhost:3000` whenever the port is known, in any status, else `''`. */
  portLabel: string;
  /** How long a start may take before the health gate gives up, in ms. */
  startBudgetMs: number;
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

const LOCAL_HOST = 'localhost';

function statusOf(row: InventoryServer, transient: TransientStatus | undefined): ServerStatus {
  if (transient !== undefined) return transient;
  return row.status === 'running' ? 'running' : row.status === 'failed' ? 'failed' : 'stopped';
}

function rowView(row: InventoryServer, hints: ServersViewHints, transient: TransientStatus | undefined): ServerRowView {
  const status = statusOf(row, transient);
  const reachable = status === 'running' && row.host !== null && row.port !== null;
  return {
    serverId: row.id,
    service: row.repo,
    status,
    statusLabel: STATUS_LABEL[status],
    address: reachable ? `${row.host}:${row.port}` : '',
    reachable,
    openable: reachable && row.httpHealth,
    reason: status === 'failed' ? (row.lastError ?? '') : '',
    portLabel: row.port === null ? '' : `${row.host ?? LOCAL_HOST}:${row.port}`,
    startBudgetMs: hints.startBudgetMs?.(row.repo) ?? DEFAULT_START_BUDGET_MS,
  };
}

function sharedView(row: SharedServer, hints: ServersViewHints): SharedRowView {
  const base = rowView(row, hints, hints.sharedVerbs?.get(row.repo));
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

export function buildServersState(
  inventory: ServerInventory,
  scopeLabel: string,
  hints: ServersViewHints = {},
): ServersState {
  const shared = inventory.shared.map((row) => sharedView(row, hints));
  const groups = inventory.tickets.map((g): TicketGroupView => {
    const servers = g.servers.map((row) => rowView(row, hints, hints.rowVerbs?.get(row.id)));
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
