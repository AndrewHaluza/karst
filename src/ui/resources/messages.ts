import type { ActionResultMessage } from '../../model/actionResult.js';
import type { ResourcesState, DiskRowView } from './state.js';
import type { ServersState } from './serversState.js';

/**
 * Message protocol for the resources + servers webview.
 *
 * The webview is a trust boundary, so every inbound message is narrowed here
 * before it reaches an action. The webview NEVER sends a pid or a path — only a
 * `servers.id` (`kill-server`, the ticket-row verbs), a unit key (`shared-*`) or
 * a `tickets.id`, all of which the host re-resolves against a fresh read before
 * acting, exactly as `merge-pr` carries only a repo name. A crafted message
 * cannot name a process or a directory to act on.
 */

export type PanelTab = 'servers' | 'resources';

export type ResourcesWebviewMessage =
  | { type: 'request-state' }
  | { type: 'kill-server'; serverId: number }
  | { type: 'refresh' }
  | { type: 'measure-disk' }
  | { type: 'shared-start'; repo: string }
  | { type: 'shared-restart'; repo: string }
  | { type: 'shared-stop'; repo: string }
  | { type: 'shared-pin'; repo: string; pinned: boolean }
  | { type: 'stop-idle' }
  | { type: 'server-start'; serverId: number }
  | { type: 'server-restart'; serverId: number }
  | { type: 'server-stop'; serverId: number }
  | { type: 'server-open'; serverId: number }
  | { type: 'server-copy'; serverId: number }
  | { type: 'ticket-stop-all'; ticketId: number }
  | { type: 'ticket-logs'; ticketId: number }
  | { type: 'open-logs' };

export type ResourcesHostMessage =
  | { type: 'state'; state: ResourcesState }
  | { type: 'servers'; state: ServersState }
  | { type: 'show-tab'; tab: PanelTab }
  | { type: 'disk'; rows: DiskRowView[] }
  | ActionResultMessage;

export interface ResourcesActions {
  requestState(): void | Promise<void>;
  killServer(serverId: number): void | Promise<void>;
  refresh(): void | Promise<void>;
  measureDisk(): void | Promise<void>;
  sharedStart(repo: string): void | Promise<void>;
  sharedRestart(repo: string): void | Promise<void>;
  sharedStop(repo: string): void | Promise<void>;
  sharedPin(repo: string, pinned: boolean): void | Promise<void>;
  stopIdle(): void | Promise<void>;
  serverStart(serverId: number): void | Promise<void>;
  serverRestart(serverId: number): void | Promise<void>;
  serverStop(serverId: number): void | Promise<void>;
  serverOpen(serverId: number): void | Promise<void>;
  serverCopy(serverId: number): void | Promise<void>;
  ticketStopAll(ticketId: number): void | Promise<void>;
  ticketLogs(ticketId: number): void | Promise<void>;
  openLogs(): void | Promise<void>;
}

const MAX_REPO_CHARS = 200;

const positiveInt = (v: unknown): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v > 0;

const unitKey = (v: unknown): v is string =>
  typeof v === 'string' && v.length > 0 && v.length <= MAX_REPO_CHARS;

/** Verbs that carry exactly one positive `servers.id`. */
const SERVER_ID_VERBS = [
  'kill-server',
  'server-start',
  'server-restart',
  'server-stop',
  'server-open',
  'server-copy',
] as const;

/** Verbs that carry exactly one unit key. */
const REPO_VERBS = ['shared-start', 'shared-restart', 'shared-stop'] as const;

/** Verbs that carry nothing. */
const BARE_VERBS = ['request-state', 'refresh', 'measure-disk', 'stop-idle', 'open-logs'] as const;

/** Narrow an untrusted webview message; null for anything malformed. */
export function parseResourcesMessage(raw: unknown): ResourcesWebviewMessage | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const m = raw as Record<string, unknown>;
  const type = m.type;
  if ((BARE_VERBS as readonly unknown[]).includes(type)) {
    return { type } as ResourcesWebviewMessage;
  }
  if ((SERVER_ID_VERBS as readonly unknown[]).includes(type)) {
    return positiveInt(m.serverId) ? ({ type, serverId: m.serverId } as ResourcesWebviewMessage) : null;
  }
  if ((REPO_VERBS as readonly unknown[]).includes(type)) {
    return unitKey(m.repo) ? ({ type, repo: m.repo } as ResourcesWebviewMessage) : null;
  }
  switch (type) {
    case 'shared-pin':
      return unitKey(m.repo) && typeof m.pinned === 'boolean'
        ? { type, repo: m.repo, pinned: m.pinned }
        : null;
    case 'ticket-stop-all':
    case 'ticket-logs':
      return positiveInt(m.ticketId) ? { type, ticketId: m.ticketId } : null;
    default:
      return null;
  }
}

/**
 * Dispatch an ALREADY-PARSED message to its action. The single dispatch seam
 * (panel.ts) parses the raw message once, reads its `requestId` off the raw
 * shape, and wraps this call in `reportAction` (UI-R13).
 */
export function routeResourcesAction(
  msg: ResourcesWebviewMessage,
  actions: ResourcesActions,
): void | Promise<void> {
  switch (msg.type) {
    case 'request-state':
      return actions.requestState();
    case 'kill-server':
      return actions.killServer(msg.serverId);
    case 'refresh':
      return actions.refresh();
    case 'measure-disk':
      return actions.measureDisk();
    case 'shared-start':
      return actions.sharedStart(msg.repo);
    case 'shared-restart':
      return actions.sharedRestart(msg.repo);
    case 'shared-stop':
      return actions.sharedStop(msg.repo);
    case 'shared-pin':
      return actions.sharedPin(msg.repo, msg.pinned);
    case 'stop-idle':
      return actions.stopIdle();
    case 'server-start':
      return actions.serverStart(msg.serverId);
    case 'server-restart':
      return actions.serverRestart(msg.serverId);
    case 'server-stop':
      return actions.serverStop(msg.serverId);
    case 'server-open':
      return actions.serverOpen(msg.serverId);
    case 'server-copy':
      return actions.serverCopy(msg.serverId);
    case 'ticket-stop-all':
      return actions.ticketStopAll(msg.ticketId);
    case 'ticket-logs':
      return actions.ticketLogs(msg.ticketId);
    case 'open-logs':
      return actions.openLogs();
  }
}
