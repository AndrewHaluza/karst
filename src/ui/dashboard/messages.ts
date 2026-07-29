import type { DashboardState } from './state.js';
import type { ShipStepEvent } from '../../workflow/stages/ship.js';
import { isHttpUrl } from '../shared/url.js';

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
  | { type: 'restart-servers' }
  | { type: 'stop-servers' }
  | { type: 'diff-worktree'; path: string }
  | { type: 'open-worktree-folder'; path: string }
  | { type: 'open-pr'; url: string }
  | { type: 'open-ticket-link'; url: string }
  | { type: 'edit-ticket' }
  | { type: 'stop-driver' }
  | { type: 'ship-ticket' }
  | { type: 'resume-ticket' }
  | { type: 'create-follow-up-ticket' }
  | { type: 'open-stage-log'; path: string }
  | { type: 'resolve-conflicts'; repo: string }
  /**
   * Flip the terminal↔dashboard binding. Carries no value on purpose: the host
   * holds the preference and the webview only renders what it is pushed, so the
   * two can never disagree about which way the toggle currently sits.
   */
  | { type: 'toggle-bind' };

/**
 * Host → webview messages. `state` pushes drive the stepper + panels;
 * `ship-progress` overlays live ship steps that are not in the store; `bind`
 * carries the window's terminal-binding preference, which is host-owned and
 * likewise absent from `DashboardState`.
 */
export type HostMessage =
  | { type: 'state'; state: DashboardState }
  | { type: 'ship-progress'; event: ShipStepEvent }
  | { type: 'bind'; enabled: boolean };

/** The daemon-facing side-effects a dashboard can trigger. */
export interface DashboardActions {
  stopServer: (serverId: number) => void;
  restartServer: (serverId: number) => void;
  openServer: (serverId: number) => void;
  copyServerUrl: (serverId: number) => void;
  spinServers: () => void;
  /**
   * Whole-ticket controls, distinct from their per-row namesakes: these take no
   * server id because the dashboard header acts on every service in scope, and
   * the two zero-row states (nothing started yet / everything stopped) have no
   * row to carry an id at all.
   */
  restartServers: () => void;
  stopServers: () => void;
  diffWorktree: (path: string) => void;
  openWorktreeFolder: (path: string) => void;
  openPr: (url: string) => void;
  openTicketLink: (url: string) => void;
  editTicket: () => void;
  stopDriver: () => void;
  shipTicket: () => void;
  resumeTicket: () => void;
  /** Create a linked follow-up ticket from this (done) ticket. */
  createFollowUpTicket: () => void;
  /** Open a stage's log (uat/review artifact) in an editor. */
  openStageLog: (path: string) => void;
  /**
   * Hand one repo's merge conflict to an agent session, seeded with the conflict
   * context. Takes the repo (not a path) because the host resolves the worktree
   * itself — the webview must not be able to name an arbitrary directory to open
   * a session in.
   */
  resolveConflicts: (repo: string) => void;
  /** Flip the window's terminal↔dashboard binding. */
  toggleBind: () => void;
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
    // Panel-level: no payload is read, so a stray `serverId` is dropped rather
    // than reshaped — these must never degrade into their per-row namesakes.
    case 'restart-servers':
      return { type: 'restart-servers' };
    case 'stop-servers':
      return { type: 'stop-servers' };
    case 'diff-worktree':
      return path ? { type: 'diff-worktree', path: m.path as string } : null;
    case 'open-worktree-folder':
      return path ? { type: 'open-worktree-folder', path: m.path as string } : null;
    case 'open-pr':
      return isHttpUrl(m.url) ? { type: 'open-pr', url: m.url } : null;
    case 'open-ticket-link':
      return isHttpUrl(m.url) ? { type: 'open-ticket-link', url: m.url } : null;
    case 'edit-ticket':
      return { type: 'edit-ticket' };
    case 'stop-driver':
      return { type: 'stop-driver' };
    case 'ship-ticket':
      return { type: 'ship-ticket' };
    case 'resume-ticket':
      return { type: 'resume-ticket' };
    case 'create-follow-up-ticket':
      return { type: 'create-follow-up-ticket' };
    case 'open-stage-log':
      return path ? { type: 'open-stage-log', path: m.path as string } : null;
    case 'resolve-conflicts':
      return typeof m.repo === 'string' && m.repo.length > 0
        ? { type: 'resolve-conflicts', repo: m.repo }
        : null;
    // Payload-free like the panel-level server controls: a companion `enabled`
    // is dropped rather than honored, so the host's value stays authoritative.
    case 'toggle-bind':
      return { type: 'toggle-bind' };
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
    case 'restart-servers':
      actions.restartServers();
      return;
    case 'stop-servers':
      actions.stopServers();
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
    case 'create-follow-up-ticket':
      actions.createFollowUpTicket();
      return;
    case 'open-stage-log':
      actions.openStageLog(msg.path);
      return;
    case 'resolve-conflicts':
      actions.resolveConflicts(msg.repo);
      return;
    case 'toggle-bind':
      actions.toggleBind();
      return;
  }
}
