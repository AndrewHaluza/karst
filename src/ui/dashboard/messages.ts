import type { DashboardState } from './state.js';
import type { ShipStepEvent } from '../../workflow/stages/ship.js';
import { isHttpUrl } from '../shared/url.js';
import type { WorktreeStats } from './worktreeStats.js';
import type { ActionResultMessage } from '../../model/actionResult.js';

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
  | { type: 'show-changes' }
  | { type: 'open-worktree-terminal'; path: string }
  | { type: 'open-worktree-folder'; path: string }
  | { type: 'copy-worktree-branch'; branch: string }
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
   * Merge one repo's PR from the ship stage. Carries the repo ONLY: the merge
   * method is asked for host-side, in the confirmation the user must answer, so a
   * crafted (or stale) message can neither choose the strategy nor skip the
   * confirmation of an irreversible action.
   */
  | { type: 'merge-pr'; repo: string }
  /**
   * Re-probe this ticket's PRs and their mergeability NOW, instead of waiting for
   * the background sweep. Payload-free: which ticket (and which project) is the
   * host's to know, so a message cannot aim the probe at anything else.
   */
  | { type: 'refresh-prs' }
  /**
   * Flip the terminal↔dashboard binding. Carries no value on purpose: the host
   * holds the preference and the webview only renders what it is pushed, so the
   * two can never disagree about which way the toggle currently sits.
   */
  | { type: 'toggle-bind' }
  /** Request the host-owned picker for this panel's current live session. */
  | { type: 'switch-agent' };

/**
 * Host → webview messages. `state` pushes drive the stepper + panels;
 * `ship-progress` overlays live ship steps that are not in the store; `bind`
 * carries the window's terminal-binding preference, which is host-owned and
 * likewise absent from `DashboardState`.
 */
export type HostMessage =
  | { type: 'state'; state: DashboardState }
  | { type: 'worktree-stats'; stats: WorktreeStats[] }
  | { type: 'ship-progress'; event: ShipStepEvent }
  | { type: 'bind'; enabled: boolean }
  | ActionResultMessage;

/**
 * The daemon-facing side-effects a dashboard can trigger.
 *
 * Every method's return type is widened from `() => void` to
 * `() => void | Promise<void>` (§ `docs/ui/DESIGN-SYSTEM.md` §5.3, UI-R13) — a
 * TYPE WIDENING, so every existing `extension.ts` implementation still
 * satisfies it unchanged. The single dispatch seam in `panel.ts` awaits
 * whatever comes back and reports the real terminal outcome as
 * `action-result`; a method that keeps returning `void` keeps its exact
 * current semantics (an immediate ack). `shipTicket`/`mergePr`/`refreshPrs` in
 * particular do NOT return their inner promise today (they fire-and-forget a
 * multi-second/-minute network operation), so their host ack is immediate —
 * the webview settles those three from the next `state` push instead of this
 * channel (§5.1's "or the next state push"); see webview.html.
 */
export interface DashboardActions {
  stopServer: (serverId: number) => void | Promise<void>;
  restartServer: (serverId: number) => void | Promise<void>;
  openServer: (serverId: number) => void | Promise<void>;
  copyServerUrl: (serverId: number) => void | Promise<void>;
  spinServers: () => void | Promise<void>;
  /**
   * Whole-ticket controls, distinct from their per-row namesakes: these take no
   * server id because the dashboard header acts on every service in scope, and
   * the two zero-row states (nothing started yet / everything stopped) have no
   * row to carry an id at all.
   */
  restartServers: () => void | Promise<void>;
  stopServers: () => void | Promise<void>;
  showChanges: () => void | Promise<void>;
  openWorktreeTerminal: (path: string) => void | Promise<void>;
  openWorktreeFolder: (path: string) => void | Promise<void>;
  copyWorktreeBranch: (branch: string) => void | Promise<void>;
  openPr: (url: string) => void | Promise<void>;
  openTicketLink: (url: string) => void | Promise<void>;
  editTicket: () => void | Promise<void>;
  stopDriver: () => void | Promise<void>;
  shipTicket: () => void | Promise<void>;
  resumeTicket: () => void | Promise<void>;
  /** Create a linked follow-up ticket from this (done) ticket. */
  createFollowUpTicket: () => void | Promise<void>;
  /** Open a stage's log (uat/review artifact) in an editor. */
  openStageLog: (path: string) => void | Promise<void>;
  /**
   * Hand one repo's merge conflict to an agent session, seeded with the conflict
   * context. Takes the repo (not a path) because the host resolves the worktree
   * itself — the webview must not be able to name an arbitrary directory to open
   * a session in.
   */
  resolveConflicts: (repo: string) => void | Promise<void>;
  /**
   * Merge one repo's PR. Takes the repo (not a url or a number) for the same
   * reason `resolveConflicts` does: the host resolves the PR from the store, so
   * the webview cannot name an arbitrary pull request to merge.
   */
  mergePr: (repo: string) => void | Promise<void>;
  /**
   * Re-probe this ticket's PR statuses and mergeability immediately, bypassing
   * the sweep's freshness floor, and push the result. Takes nothing: the closure
   * already owns the ticket, and the panel is asking for "again", not "this one".
   */
  refreshPrs: () => void | Promise<void>;
  /** Flip the window's terminal↔dashboard binding. */
  toggleBind: () => void | Promise<void>;
  /** Switch the panel's live agent session through the host-owned picker. */
  switchAgent: () => void | Promise<void>;
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
  const branch = typeof m.branch === 'string' && m.branch.length > 0;
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
    case 'show-changes':
      return { type: 'show-changes' };
    case 'open-worktree-terminal':
      return path ? { type: 'open-worktree-terminal', path: m.path as string } : null;
    case 'open-worktree-folder':
      return path ? { type: 'open-worktree-folder', path: m.path as string } : null;
    case 'copy-worktree-branch':
      return branch ? { type: 'copy-worktree-branch', branch: m.branch as string } : null;
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
    // A companion `method` is DROPPED, not honored: how to merge is the host's
    // question to the user, never the webview's to answer.
    case 'merge-pr':
      return typeof m.repo === 'string' && m.repo.length > 0
        ? { type: 'merge-pr', repo: m.repo }
        : null;
    // Payload-free like the panel-level server controls: a companion `repo` or
    // ticket id is dropped, so the refresh can only ever re-probe the ticket the
    // host already opened this panel for.
    case 'refresh-prs':
      return { type: 'refresh-prs' };
    // Payload-free like the panel-level server controls: a companion `enabled`
    // is dropped rather than honored, so the host's value stays authoritative.
    case 'toggle-bind':
      return { type: 'toggle-bind' };
    // Payload-free: the panel closure owns the ticket and re-reads the live
    // session before switching, so no webview-supplied target can be trusted.
    case 'switch-agent':
      return { type: 'switch-agent' };
    default:
      return null;
  }
}

/**
 * Route an untrusted webview message to the matching action. The message is
 * validated at this boundary; unknown / malformed shapes are ignored so a stray
 * or hostile message can't crash the host or drive an action with bad input.
 *
 * Returns whatever the matched action returns (`void` or a `Promise<void>`) so
 * the single dispatch seam in `panel.ts` can await it and report one terminal
 * `action-result` (§ `docs/ui/DESIGN-SYSTEM.md` §5.3, UI-R13). An unparsed
 * message returns `undefined` WITHOUT calling any action.
 */
export function routeAction(raw: unknown, actions: DashboardActions): void | Promise<void> {
  const msg = parseWebviewMessage(raw);
  if (!msg) return;
  switch (msg.type) {
    case 'stop-server':
      return actions.stopServer(msg.serverId);
    case 'restart-server':
      return actions.restartServer(msg.serverId);
    case 'open-server':
      return actions.openServer(msg.serverId);
    case 'copy-server-url':
      return actions.copyServerUrl(msg.serverId);
    case 'spin-servers':
      return actions.spinServers();
    case 'restart-servers':
      return actions.restartServers();
    case 'stop-servers':
      return actions.stopServers();
    case 'show-changes':
      return actions.showChanges();
    case 'open-worktree-terminal':
      return actions.openWorktreeTerminal(msg.path);
    case 'open-worktree-folder':
      return actions.openWorktreeFolder(msg.path);
    case 'copy-worktree-branch':
      return actions.copyWorktreeBranch(msg.branch);
    case 'open-pr':
      return actions.openPr(msg.url);
    case 'open-ticket-link':
      return actions.openTicketLink(msg.url);
    case 'edit-ticket':
      return actions.editTicket();
    case 'stop-driver':
      return actions.stopDriver();
    case 'ship-ticket':
      return actions.shipTicket();
    case 'resume-ticket':
      return actions.resumeTicket();
    case 'create-follow-up-ticket':
      return actions.createFollowUpTicket();
    case 'open-stage-log':
      return actions.openStageLog(msg.path);
    case 'resolve-conflicts':
      return actions.resolveConflicts(msg.repo);
    case 'merge-pr':
      return actions.mergePr(msg.repo);
    case 'refresh-prs':
      return actions.refreshPrs();
    case 'toggle-bind':
      return actions.toggleBind();
    case 'switch-agent':
      return actions.switchAgent();
  }
}
