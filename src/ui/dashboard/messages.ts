import type { DashboardState } from './state.js';
import { isHttpUrl } from '../shared/url.js';
import type { WorktreeStats } from './worktreeStats.js';
import type { GateOptions } from './gateOptions.js';
import type { ActionResultMessage } from '../../model/actionResult.js';
import { STAGE_KEYS, type StageKey } from '../../model/types.js';
import { GATE_STAGES, type GateStage } from '../../store/ticketGates.js';
import { validateInsideProgressEvent, type InsideProgressEvent } from '../../model/inside/progress.js';

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
  | { type: 'switch-agent' }
  /**
   * Resume a parked gate stage (§ blocked state visible). Carries the ticket
   * AND the stage it believes is blocked — the host still validates both
   * against the ticket it actually owns before touching the store: a stale
   * panel, a race with an already-cleared block, or a ticket that has since
   * moved to another stage must not be resumable by this message.
   */
  | { type: 'stage-resume'; ticketId: number; stageKey: StageKey }
  /**
   * Switch ONE named gate off (or back on) for this ticket alone.
   *
   * Carries no ticket id: the panel closure already owns the ticket, exactly
   * like `refresh-prs` and `merge-pr`, so a crafted message cannot aim a
   * disable at another ticket. The stage is narrowed to the two that resolve
   * gates at all, and the name is a bounded string matched against a RESOLVED
   * gate name host-side — it never becomes a command.
   */
  | { type: 'set-disabled-gates'; stage: GateStage; name: string; disabled: boolean }
  /**
   * One inside action, by its OPAQUE snapshot-scoped id only. The webview never
   * sends a kind, repo, path, PR number, SHA, stage or process id — the host
   * resolves the id through the ticket's current `InsideActionRegistry` and
   * dispatches the STORED target, so a crafted or stale message cannot aim an
   * action anywhere. The message is closed: any companion field beyond an
   * optional well-formed `requestId` drops the whole message.
   */
  | { type: 'inside-action'; actionId: string };

/**
 * Host → webview messages. `state` pushes drive the stepper + panels;
 * `inside-progress` overlays live process events (gates, Fix, and Ship — the
 * ship lifecycle rides this same union, Finding 12); `bind` carries the
 * window's terminal-binding preference, which is host-owned and likewise
 * absent from `DashboardState`.
 */
export type HostMessage =
  | { type: 'state'; state: DashboardState }
  | { type: 'worktree-stats'; stats: WorktreeStats[] }
  | { type: 'inside-progress'; event: InsideProgressEvent }
  | { type: 'bind'; enabled: boolean }
  /**
   * The togglable gate names for this ticket. Its own message, not part of
   * `DashboardState`, because resolving it probes the filesystem and
   * `buildDashboardState` is synchronous — same split as `worktree-stats`.
   */
  | { type: 'gate-options'; options: GateOptions }
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
  /**
   * Clear a stage's block and try to drive it forward. Takes the message's
   * `ticketId`/`stageKey` VERBATIM (not pre-validated) so the host can apply
   * every check — same ticket, same current stage, actually blocked — in one
   * place, right against the store it is about to mutate.
   */
  resumeStage: (ticketId: number, stageKey: StageKey) => void | Promise<void>;
  /**
   * Switch one gate off (or on) for this ticket. Takes the stage and the gate
   * NAME — never a command or a script — so the webview can express only which
   * question to withdraw, never what to run.
   */
  setDisabledGate: (stage: GateStage, name: string, disabled: boolean) => void | Promise<void>;
  /**
   * Dispatch one opaque inside action id against the ticket's CURRENT action
   * registry. The host resolves the id; the webview cannot name a target.
   */
  insideAction: (actionId: string) => void | Promise<void>;
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
    // Both fields are required and typed here, at the boundary — a missing or
    // malformed one drops the whole message rather than resuming with a
    // guessed ticket or an invalid stage.
    case 'stage-resume':
      return isFiniteNumber(m.ticketId) && isStageKey(m.stageKey)
        ? { type: 'stage-resume', ticketId: m.ticketId as number, stageKey: m.stageKey }
        : null;
    // Every field is required and typed here, at the trust boundary: `stage` is
    // narrowed to the closed `GATE_STAGES` set, and a blank or oversized name
    // drops the whole message rather than reaching a store write.
    //
    // The name itself is stored VERBATIM — it is deliberately not checked
    // against the resolved gate list. Resolution matches by exact name
    // (`partitionDisabled`), so a name that no gate carries disables nothing;
    // and a gate renamed in karst.yml must keep its stored entry rather than
    // have it silently dropped, or renaming it back would lose the user's
    // choice. Bounded, inert, and recoverable beats validated-and-forgotten.
    case 'set-disabled-gates': {
      const name = typeof m.name === 'string' ? m.name.trim() : '';
      return isGateStage(m.stage) &&
        name.length > 0 &&
        name.length <= MAX_GATE_NAME_CHARS &&
        typeof m.disabled === 'boolean'
        ? { type: 'set-disabled-gates', stage: m.stage, name, disabled: m.disabled }
        : null;
    }
    case 'inside-action': {
      // CLOSED message: `type` + `actionId` (+ an optional `requestId` the
      // panel's readRequestId validates separately) and NOTHING else. Any
      // other companion field — a forged kind, repo, path, PR number or SHA —
      // drops the whole message rather than being ignored: a legacy-shaped
      // target-bearing payload is rejected, never downgraded to an id lookup.
      const extra = Object.keys(m).filter(
        (k) => k !== 'type' && k !== 'actionId' && k !== 'requestId',
      );
      if (extra.length > 0) return null;
      const actionId = typeof m.actionId === 'string' ? m.actionId : '';
      if (actionId.length === 0 || actionId.length > MAX_ACTION_ID_CHARS) return null;
      if (!/^[A-Za-z0-9:_-]+$/.test(actionId)) return null;
      return { type: 'inside-action', actionId };
    }
    default:
      return null;
  }
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function isStageKey(v: unknown): v is StageKey {
  return typeof v === 'string' && (STAGE_KEYS as readonly string[]).includes(v);
}

function isGateStage(v: unknown): v is GateStage {
  return typeof v === 'string' && (GATE_STAGES as readonly string[]).includes(v);
}

/** Longest gate name accepted from a webview. Real names are short script keys. */
const MAX_GATE_NAME_CHARS = 128;

/** Longest inside action id accepted from a webview. Ids are `snapshot-<n>:action-<n>`. */
export const MAX_ACTION_ID_CHARS = 96;

/**
 * Narrow an untrusted host→webview inside-progress payload to a closed
 * `InsideProgressEvent`, validating the discriminant/status combinations in
 * one place (the webview is a trust boundary in both directions: a host bug
 * must not ship an event the renderer cannot handle). The webview's own
 * renderer switch can therefore meet only known shapes.
 */
export function parseInsideProgress(raw: unknown): InsideProgressEvent | null {
  return validateInsideProgressEvent(raw);
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
    case 'stage-resume':
      return actions.resumeStage(msg.ticketId, msg.stageKey);
    case 'set-disabled-gates':
      return actions.setDisabledGate(msg.stage, msg.name, msg.disabled);
    case 'inside-action':
      return actions.insideAction(msg.actionId);
  }
}
