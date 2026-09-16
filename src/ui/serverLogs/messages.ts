import type { ServerLogEntry } from '../dashboard/messages.js';

/**
 * Message protocol for the standalone server-logs panel.
 *
 * It mirrors the dashboard's four log messages, narrowed to this panel: the
 * webview asks for the logs and closes itself; the host answers with the
 * initial `server-logs` snapshot and then streams `server-log-output` chunks.
 * The server element shape is `ServerLogEntry` from the dashboard's boundary —
 * imported, never redeclared, so the two hosts can never drift.
 *
 * Parsing follows the dashboard's `parse...Message` discipline: a `switch` over
 * the string discriminant, `null` for anything unrecognised. Both messages are
 * payload-free — the panel closure owns the ticket.
 */
export type ServerLogsWebviewMessage =
  | { type: 'server-logs-request' }
  | { type: 'server-logs-close' };

export type ServerLogsHostMessage =
  | { type: 'server-logs'; servers: ServerLogEntry[] }
  | { type: 'server-log-output'; service: string; text: string };

/** The host-side effects the standalone panel can trigger. */
export interface ServerLogsActions {
  request(): void | Promise<void>;
  close(): void | Promise<void>;
}

/** Narrow an untrusted webview message; null for anything malformed. */
export function parseServerLogsMessage(raw: unknown): ServerLogsWebviewMessage | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const m = raw as Record<string, unknown>;
  switch (m.type) {
    case 'server-logs-request':
      return { type: 'server-logs-request' };
    case 'server-logs-close':
      return { type: 'server-logs-close' };
    default:
      return null;
  }
}

/** Dispatch an already-parsed message to its action, returning its outcome. */
export function routeServerLogsAction(
  msg: ServerLogsWebviewMessage,
  actions: ServerLogsActions,
): void | Promise<void> {
  switch (msg.type) {
    case 'server-logs-request':
      return actions.request();
    case 'server-logs-close':
      return actions.close();
  }
}
