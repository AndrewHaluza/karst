/**
 * The one table of server status words and verb labels for the Servers &
 * resources panel (RS-17). The host read model, the webview row mark and the
 * Server logs tab label read these words; no surface spells its own copy.
 *
 * A crash is the existing `failed` state with a reason (`servers.last_error`),
 * never a fifth word. `starting` and `stopping` are transient verb states the
 * host holds while an action runs; they are not crash states.
 */

export type ServerStatusWord = 'running' | 'starting' | 'stopping' | 'stopped' | 'failed' | 'missing';

/** The word shown next to the status shape (UI-R28: never shape or colour alone). */
export const SERVER_STATUS_WORD: Readonly<Record<ServerStatusWord, string>> = {
  running: 'Running',
  starting: 'Starting…',
  stopping: 'Stopping…',
  stopped: 'Stopped',
  failed: 'Failed',
  missing: 'Missing',
};

/** The shape that carries each status with its word. */
export const SERVER_STATUS_MARK: Readonly<Record<ServerStatusWord, string>> = {
  running: '●',
  starting: '◌',
  stopping: '◌',
  stopped: '○',
  failed: '✕',
  missing: '?',
};

/** The visible labels of the row and group verbs. */
export const SERVER_VERB_LABEL = {
  start: 'Start',
  stop: 'Stop',
  restart: 'Restart',
  logs: 'Logs',
  open: 'Open',
  copyUrl: 'Copy URL',
  copyAddress: 'Copy address',
  copied: 'Copied',
  keepRunning: 'Keep running',
  stopAll: 'Stop all',
  stopIdle: 'Stop idle',
  stopServers: 'Stop servers',
  stopProcess: 'Stop process',
} as const;

/** The chip on a pinned shared service that runs ("Keep running" is the button). */
export const KEPT_RUNNING_CHIP = 'Kept running';

/**
 * The word for a stored `servers.status`. The `servers` table only ever holds
 * `running`, `failed` or a retired `stopped`; anything else reads Stopped, never
 * an invented state (RS-17).
 */
export function serverStatusWordOf(status: string): string {
  return status === 'running'
    ? SERVER_STATUS_WORD.running
    : status === 'failed'
      ? SERVER_STATUS_WORD.failed
      : SERVER_STATUS_WORD.stopped;
}

/** The Servers tab's one empty state: no server runs in the project (RS-19). */
export const EMPTY_SERVERS_TITLE = 'No servers run in this project';
export const EMPTY_SERVERS_HINT =
  'Start a ticket session to start its servers. Shared services show here when a ticket needs one.';
