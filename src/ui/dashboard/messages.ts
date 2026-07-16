import type { DashboardState } from './state.js';

/**
 * Webview → host action messages (§14 dashboard tier actions). The webview
 * posts these; the host routes them to daemon actions via `routeAction`.
 */
export type WebviewMessage =
  | { type: 'stop-server'; serverId: number }
  | { type: 'restart-server'; serverId: number }
  | { type: 'open-server'; serverId: number }
  | { type: 'copy-server-url'; serverId: number }
  | { type: 'spin-servers' }
  | { type: 'diff-worktree'; path: string }
  | { type: 'open-worktree-folder'; path: string }
  | { type: 'open-pr'; url: string }
  | { type: 'open-ticket-link'; url: string }
  | { type: 'edit-ticket' }
  | { type: 'stop-driver' }
  | { type: 'ship-ticket' }
  | { type: 'resume-ticket' }
  | { type: 'open-stage-log'; path: string };

/** Host → webview messages: state pushes drive the stepper + panels. */
export type HostMessage = { type: 'state'; state: DashboardState };

/** The daemon-facing side-effects a dashboard can trigger. */
export interface DashboardActions {
  stopServer: (serverId: number) => void;
  restartServer: (serverId: number) => void;
  openServer: (serverId: number) => void;
  copyServerUrl: (serverId: number) => void;
  spinServers: () => void;
  diffWorktree: (path: string) => void;
  openWorktreeFolder: (path: string) => void;
  openPr: (url: string) => void;
  openTicketLink: (url: string) => void;
  editTicket: () => void;
  stopDriver: () => void;
  shipTicket: () => void;
  resumeTicket: () => void;
  /** Open a stage's log (uat/review artifact) in an editor. */
  openStageLog: (path: string) => void;
}

/**
 * Narrow an untrusted webview message to a `WebviewMessage`, validating BOTH the
 * discriminant and its companion field's type — the webview is a trust boundary,
 * so `serverId` must be a number and `path`/`url` must be strings before they
 * reach `Uri.file`/`Uri.parse`/`executeCommand`. `url` must also be http(s), so
 * a crafted `file://`/other-scheme message can't drive `openExternal`. Returns
 * null for anything malformed.
 */
export function parseWebviewMessage(raw: unknown): WebviewMessage | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const m = raw as Record<string, unknown>;
  const num = typeof m.serverId === 'number' && Number.isFinite(m.serverId);
  const path = typeof m.path === 'string' && m.path.length > 0;
  switch (m.type) {
    case 'stop-server':
      return num ? { type: 'stop-server', serverId: m.serverId as number } : null;
    case 'restart-server':
      return num ? { type: 'restart-server', serverId: m.serverId as number } : null;
    case 'open-server':
      return num ? { type: 'open-server', serverId: m.serverId as number } : null;
    case 'copy-server-url':
      return num ? { type: 'copy-server-url', serverId: m.serverId as number } : null;
    case 'spin-servers':
      return { type: 'spin-servers' };
    case 'diff-worktree':
      return path ? { type: 'diff-worktree', path: m.path as string } : null;
    case 'open-worktree-folder':
      return path ? { type: 'open-worktree-folder', path: m.path as string } : null;
    case 'open-pr':
      return typeof m.url === 'string' && /^https?:\/\//.test(m.url)
        ? { type: 'open-pr', url: m.url }
        : null;
    case 'open-ticket-link':
      return typeof m.url === 'string' && /^https?:\/\//.test(m.url)
        ? { type: 'open-ticket-link', url: m.url }
        : null;
    case 'edit-ticket':
      return { type: 'edit-ticket' };
    case 'stop-driver':
      return { type: 'stop-driver' };
    case 'ship-ticket':
      return { type: 'ship-ticket' };
    case 'resume-ticket':
      return { type: 'resume-ticket' };
    case 'open-stage-log':
      return path ? { type: 'open-stage-log', path: m.path as string } : null;
    default:
      return null;
  }
}

/**
 * Route an untrusted webview message to the matching action. The message is
 * validated at this boundary; unknown / malformed shapes are ignored so a stray
 * or hostile message can't crash the host or drive an action with bad input.
 */
export function routeAction(raw: unknown, actions: DashboardActions): void {
  const msg = parseWebviewMessage(raw);
  if (!msg) return;
  switch (msg.type) {
    case 'stop-server':
      actions.stopServer(msg.serverId);
      return;
    case 'restart-server':
      actions.restartServer(msg.serverId);
      return;
    case 'open-server':
      actions.openServer(msg.serverId);
      return;
    case 'copy-server-url':
      actions.copyServerUrl(msg.serverId);
      return;
    case 'spin-servers':
      actions.spinServers();
      return;
    case 'diff-worktree':
      actions.diffWorktree(msg.path);
      return;
    case 'open-worktree-folder':
      actions.openWorktreeFolder(msg.path);
      return;
    case 'open-pr':
      actions.openPr(msg.url);
      return;
    case 'open-ticket-link':
      actions.openTicketLink(msg.url);
      return;
    case 'edit-ticket':
      actions.editTicket();
      return;
    case 'stop-driver':
      actions.stopDriver();
      return;
    case 'ship-ticket':
      actions.shipTicket();
      return;
    case 'resume-ticket':
      actions.resumeTicket();
      return;
    case 'open-stage-log':
      actions.openStageLog(msg.path);
      return;
  }
}
