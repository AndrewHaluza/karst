import type { ActionResultMessage } from '../../model/actionResult.js';
import type { ResourcesState, DiskRowView } from './state.js';

/**
 * Message protocol for the resources webview.
 *
 * The webview is a trust boundary, so every inbound message is narrowed here
 * before it reaches an action. The webview NEVER sends a pid or a path — only a
 * `servers.id` (`kill-server`) that the host re-resolves through fresh
 * attribution, exactly as `merge-pr` carries only a repo name. A crafted
 * message cannot name a process or a directory to act on.
 */

export type ResourcesWebviewMessage =
  | { type: 'request-state' }
  | { type: 'kill-server'; serverId: number }
  | { type: 'refresh' }
  | { type: 'measure-disk' };

export type ResourcesHostMessage =
  | { type: 'state'; state: ResourcesState }
  | { type: 'disk'; rows: DiskRowView[] }
  | ActionResultMessage;

export interface ResourcesActions {
  requestState(): void | Promise<void>;
  killServer(serverId: number): void | Promise<void>;
  refresh(): void | Promise<void>;
  measureDisk(): void | Promise<void>;
}

/** Narrow an untrusted webview message; null for anything malformed. */
export function parseResourcesMessage(raw: unknown): ResourcesWebviewMessage | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const m = raw as Record<string, unknown>;
  switch (m.type) {
    case 'request-state':
      return { type: 'request-state' };
    case 'kill-server':
      return typeof m.serverId === 'number' && Number.isSafeInteger(m.serverId) && m.serverId > 0
        ? { type: 'kill-server', serverId: m.serverId }
        : null;
    case 'refresh':
      return { type: 'refresh' };
    case 'measure-disk':
      return { type: 'measure-disk' };
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
  }
}
