/**
 * Type-checked webview → host message constructors for the resources + servers
 * webview.
 *
 * The app only calls `createSender(api)`'s named functions with positional
 * values; it never writes a message field name, so a typo'd or renamed field is
 * a `tsc --noEmit` error instead of a message the host silently drops.
 * `createSender` does NOT call `acquireVsCodeApi()` — that single call lives in
 * the app entry (`app/main.tsx`).
 */
import type { ResourcesWebviewMessage } from './messages.js';

/** The minimal host API a sender posts through. */
export interface WebviewApi {
  postMessage(message: unknown): void;
}

type Msg<K extends ResourcesWebviewMessage['type']> = Extract<ResourcesWebviewMessage, { type: K }>;

export function createSender(api: WebviewApi) {
  const send = (msg: ResourcesWebviewMessage, requestId?: string): void => {
    api.postMessage(requestId === undefined ? msg : { ...msg, requestId });
  };
  return {
    requestState: () => send({ type: 'request-state' }),
    refresh: (requestId?: string) => send({ type: 'refresh' }, requestId),
    measureDisk: (requestId?: string) => send({ type: 'measure-disk' }, requestId),
    killServer: (serverId: Msg<'kill-server'>['serverId'], requestId?: string) =>
      send({ type: 'kill-server', serverId }, requestId),
    sharedStart: (repo: Msg<'shared-start'>['repo'], requestId?: string) =>
      send({ type: 'shared-start', repo }, requestId),
    sharedRestart: (repo: Msg<'shared-restart'>['repo'], requestId?: string) =>
      send({ type: 'shared-restart', repo }, requestId),
    sharedStop: (repo: Msg<'shared-stop'>['repo'], requestId?: string) =>
      send({ type: 'shared-stop', repo }, requestId),
    sharedPin: (repo: Msg<'shared-pin'>['repo'], pinned: Msg<'shared-pin'>['pinned'], requestId?: string) =>
      send({ type: 'shared-pin', repo, pinned }, requestId),
    stopIdle: (requestId?: string) => send({ type: 'stop-idle' }, requestId),
    serverStart: (serverId: Msg<'server-start'>['serverId'], requestId?: string) =>
      send({ type: 'server-start', serverId }, requestId),
    serverRestart: (serverId: Msg<'server-restart'>['serverId'], requestId?: string) =>
      send({ type: 'server-restart', serverId }, requestId),
    serverStop: (serverId: Msg<'server-stop'>['serverId'], requestId?: string) =>
      send({ type: 'server-stop', serverId }, requestId),
    serverOpen: (serverId: Msg<'server-open'>['serverId'], requestId?: string) =>
      send({ type: 'server-open', serverId }, requestId),
    serverCopy: (serverId: Msg<'server-copy'>['serverId'], requestId?: string) =>
      send({ type: 'server-copy', serverId }, requestId),
    ticketStopAll: (ticketId: Msg<'ticket-stop-all'>['ticketId'], requestId?: string) =>
      send({ type: 'ticket-stop-all', ticketId }, requestId),
    ticketLogs: (ticketId: Msg<'ticket-logs'>['ticketId'], requestId?: string) =>
      send({ type: 'ticket-logs', ticketId }, requestId),
    openLogs: (requestId?: string) => send({ type: 'open-logs' }, requestId),
  };
}

export type ResourcesSender = ReturnType<typeof createSender>;
