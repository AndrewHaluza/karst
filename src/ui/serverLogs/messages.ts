import type { ServerLogEntry } from '../dashboard/messages.js';
import { MAX_SERVER_LOG_COPY_CHARS } from '../dashboard/messageValidate.js';

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
  | { type: 'server-logs-close' }
  /**
   * The search hit count; the host answers with `server-logs-match-text`.
   * `current` is the 1-based match after Prev/Next ("3 of 12").
   */
  | { type: 'server-logs-match-count'; count: number; seq: number; current?: number }
  /** The Follow-off count of new lines; the host answers with `server-logs-new-text`. */
  | { type: 'server-logs-new-count'; count: number; seq: number }
  /** Copy the shown lines; the host writes them to the clipboard. */
  | { type: 'server-logs-copy'; text: string };

export type ServerLogsHostMessage =
  | { type: 'server-logs'; servers: ServerLogEntry[]; key?: string }
  | { type: 'server-log-output'; service: string; text: string }
  /** The finished match text for the search box, from `logMatchText`. */
  | { type: 'server-logs-match-text'; seq: number; text: string }
  /** The finished new-line text for the Follow-off button, from `logNewLinesText`. */
  | { type: 'server-logs-new-text'; seq: number; text: string };

/** The host-side effects the standalone panel can trigger. */
export interface ServerLogsActions {
  request(): void | Promise<void>;
  close(): void | Promise<void>;
  matchCount(count: number, seq: number, current?: number): void | Promise<void>;
  newCount(count: number, seq: number): void | Promise<void>;
  copy(text: string): void | Promise<void>;
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
    case 'server-logs-match-count': {
      if (typeof m.count !== 'number' || !Number.isSafeInteger(m.count) || m.count < 0) return null;
      if (typeof m.seq !== 'number' || !Number.isSafeInteger(m.seq) || m.seq < 0) return null;
      if (m.current === undefined) return { type: 'server-logs-match-count', count: m.count, seq: m.seq };
      if (typeof m.current !== 'number' || !Number.isSafeInteger(m.current) || m.current < 1) return null;
      return { type: 'server-logs-match-count', count: m.count, seq: m.seq, current: m.current };
    }
    case 'server-logs-new-count': {
      if (typeof m.count !== 'number' || !Number.isSafeInteger(m.count) || m.count < 0) return null;
      if (typeof m.seq !== 'number' || !Number.isSafeInteger(m.seq) || m.seq < 0) return null;
      return { type: 'server-logs-new-count', count: m.count, seq: m.seq };
    }
    case 'server-logs-copy': {
      const text = typeof m.text === 'string' ? m.text : null;
      if (text === null || text.length > MAX_SERVER_LOG_COPY_CHARS) return null;
      return { type: 'server-logs-copy', text };
    }
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
    case 'server-logs-match-count':
      return actions.matchCount(msg.count, msg.seq, msg.current);
    case 'server-logs-new-count':
      return actions.newCount(msg.count, msg.seq);
    case 'server-logs-copy':
      return actions.copy(msg.text);
  }
}
