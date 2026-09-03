import type { DashboardState } from './state.js';
import { isHttpUrl } from '../shared/url.js';
import type { WorktreeStats } from './worktreeStats.js';
import type { GateOptions } from './gateOptions.js';
import type { ActionResultMessage } from '../../model/actionResult.js';
import { STAGE_KEYS, type StageKey } from '../../model/types.js';
import { GATE_STAGES, type GateStage } from '../../store/ticketGates.js';
import { validateInsideProgressEvent, type InsideProgressEvent } from '../../model/inside/progress.js';
import { isKnownProvider } from '../../agent/provider.js';
import type { AgentProvider } from '../../manifest/types.js';

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
  /**
   * Build one worktree's karst-extension checkout and open it as the
   * extension development host in a new window. Carries the path ONLY: the
   * host validates it against the ticket's registered worktrees (and that it
   * is actually a karst checkout) before building anything, so a crafted or
   * stale message cannot aim the build at an arbitrary directory.
   */
  | { type: 'launch-worktree-extension'; path: string }
  | { type: 'open-pr'; url: string }
  /**
   * Copy a pull request's URL through the host clipboard. Carries only the URL
   * (validated as http), and the webview flashes its own optimistic feedback —
   * the same contract as `copy-worktree-branch`.
   */
  | { type: 'copy-pr-url'; url: string }
  | { type: 'open-ticket-link'; url: string }
  | { type: 'edit-ticket' }
  | { type: 'stop-driver' }
  | { type: 'ship-ticket' }
  | { type: 'resume-ticket' }
  | { type: 'create-follow-up-ticket' }
  /**
   * The ONE explicit recovery action: move this ticket back to Implement from
   * the current stage header's ⋯ menu. Payload-free exactly like `refresh-prs`:
   * the host derives availability and the current stage from the store it is
   * about to mutate, so a crafted or stale message can neither name a stage to
   * move to nor skip the host's confirmation. The host answers with a state
   * push after the modal (confirm or cancel), which settles the webview's
   * pending state.
   */
  | { type: 'send-back-to-implement' }
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
  /**
   * Apply a staged agent-core/model selection to this ticket's live session.
   * Carries the selection VERBATIM — the host re-validates both against the
   * choices IT computed (isKnownProvider + model-choice membership) before
   * confirming or persisting, so the webview's draft is a suggestion, never
   * authority. `effort` is the optional effort/variant, staged like the model;
   * the host validates it against the selected model's advertised efforts.
   */
  | { type: 'switch-agent'; provider: AgentProvider; model: string | null; effort: string | null }
  /** Copy this ticket's key through the host clipboard (the closure owns the ticket). */
  | { type: 'copy-ticket-key' }
  /**
   * Resume a parked gate stage (§ blocked state visible). Carries the ticket
   * AND the stage it believes is blocked — the host still validates both
   * against the ticket it actually owns before touching the store: a stale
   * panel, a race with an already-cleared block, or a ticket that has since
   * moved to another stage must not be resumable by this message.
   */
  | { type: 'stage-resume'; ticketId: number; stageKey: StageKey }
  /** Pause task execution for this ticket (payload-free: the panel owns the ticket). */
  | { type: 'pause-execution' }
  /** Unpause task execution for this ticket (payload-free: the panel owns the ticket). */
  | { type: 'unpause-execution' }
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
  | { type: 'inside-action'; actionId: string }
  /**
   * Open one underlying FILE of an artifact's detail in a normal VS Code
   * editor. Carries the artifact id and a RESOURCE INDEX — never a path: the
   * host re-derives the ticket's artifacts, matches the id against them, and
   * resolves the index against THAT artifact's resource list, so a crafted or
   * stale message cannot aim the editor at an arbitrary file (same property
   * as `merge-pr`/`resolve-conflicts`). The id is a bounded string and the
   * index a non-negative integer; anything else drops the whole message.
   */
  | { type: 'artifact-open-resource'; artifactId: string; index: number }
  /**
   * Ask the host to push one gate stage's console log (the uat/review artifact
   * file) for the terminal "detailed mode" view. Carries the STAGE only — a
   * closed vocabulary: no path, no ticket id (the panel closure owns the
   * ticket), exactly like `set-disabled-gates`. The host resolves the stage
   * row's recorded artifactPath from the store, reads it, and answers with
   * `stage-log`; the answer message (ok or error) is the terminal outcome.
   */
  | { type: 'stage-log-request'; stage: GateStage }
  /**
   * Ask the host to push one gate-lane AI process's console tail (the UAT
   * Tester or the Review findings lane) for the terminal "detailed mode" view.
   * Carries the PROCESS only — a closed vocabulary (`tester`/`review`): no
   * path, no ticket id. The host resolves the persisted tail file and answers
   * with `agent-log`; the answer message (ok or error) is the terminal outcome.
   */
  | { type: 'agent-log-request'; processId: AgentProcessId }
  /**
   * Select a round of a gate stage's attempt history to view. Carries the
   * stage (narrowed to the two that carry rounds) and the attempt key, both
   * re-resolved host-side against the ticket's actual attempt history — same
   * property as `set-disabled-gates`: a crafted or stale message cannot aim
   * the view at anything the host doesn't already know about.
   */
  | { type: 'select-gate-attempt'; stage: GateStage; key: string }
  /**
   * Change a spun ticket's base branch for one repository (§ per-repo base
   * branch — live change). `repo` is the WORKTREE's repoPath, never a
   * manifest entry name — base refs are per worktree. `rebase` defaults to ON
   * when the flag is absent (the safe reading of a missing switch: a base
   * change without a rebase leaves the branch sitting on the old base). The
   * host re-resolves everything against the ticket's actual worktree before
   * touching git, so a crafted or stale message cannot aim the change at a
   * repository this ticket never scoped, or skip the refusal path.
   */
  | { type: 'change-base-ref'; repo: string; baseRef: string; rebase: boolean }
  /**
   * Retry a gate stage (uat/review) by resetting it to pending so the driver
   * re-runs it. Carries the stage — a closed vocabulary narrowed to the two
   * gate stages — validated host-side against the ticket's current stage and
   * status before anything is touched.
   */
  | { type: 'rerun-gate'; stage: GateStage };

/**
 * Host → webview messages. `state` pushes drive the stepper + panels;
 * `inside-progress` overlays live process events (gates, Fix, and Ship — the
 * ship lifecycle rides this same union, Finding 12); `bind` carries the
 * window's terminal-binding preference, which is host-owned and likewise
 * absent from `DashboardState`.
 */
export type HostMessage =
  | {
      type: 'state';
      state: DashboardState;
      /** Clock-only repaint; the webview may defer it during interaction. */
      live?: boolean;
      /** False when no worktree/gate-options follow this state message. */
      supplemental?: boolean;
      /** False when this snapshot must not settle requestless actions. */
      settlesActions?: boolean;
    }
  | { type: 'worktree-stats'; stats: WorktreeStats[] }
  | { type: 'inside-progress'; event: InsideProgressEvent }
  | { type: 'bind'; enabled: boolean }
  /**
   * The togglable gate names for this ticket. Its own message, not part of
   * `DashboardState`, because resolving it probes the filesystem and
   * `buildDashboardState` is synchronous — same split as `worktree-stats`.
   */
  | { type: 'gate-options'; options: GateOptions }
  /**
   * The answer to `stage-log-request`: the console log content for one gate
   * stage, or a named refusal. The `result` union is closed — the webview
   * renders exactly these two shapes. `truncated` is true when the file was
   * cut at the read cap (defensive; the recording itself caps at 1 MiB).
   */
  | { type: 'stage-log'; stage: GateStage; result: StageLogResult }
  /**
   * The answer to `agent-log-request`: the console tail for one gate-lane AI
   * process, or a named refusal. Same closed `result` union as `stage-log`.
   */
  | { type: 'agent-log'; processId: AgentProcessId; result: StageLogResult }
  /**
   * A live chunk of one gate-lane AI process's console output, pushed while
   * the process runs. The text is already sanitized and bounded host-side (the
   * `AgentConsole` sink); the webview appends it to the open terminal for that
   * process only.
   */
  | { type: 'agent-output'; processId: AgentProcessId; text: string }
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
  /**
   * Launch a worktree as the extension development host. The build takes
   * minutes, so this returns `void` — the button acks on host acceptance and
   * the real outcome arrives as a progress notification + state push.
   */
  launchWorktreeExtension: (path: string) => void | Promise<void>;
  openPr: (url: string) => void | Promise<void>;
  copyPrUrl: (url: string) => void | Promise<void>;
  openTicketLink: (url: string) => void | Promise<void>;
  editTicket: () => void | Promise<void>;
  stopDriver: () => void | Promise<void>;
  shipTicket: () => void | Promise<void>;
  resumeTicket: () => void | Promise<void>;
  /** Move this ticket back to Implement — the unified recovery action (host-confirmed). */
  sendBackToImplement: () => void | Promise<void>;
  /** Create a linked follow-up ticket from this (done) ticket. */
  createFollowUpTicket: () => void | Promise<void>;
  /** Open a stage's log (uat/review artifact) in an editor. */
  openStageLog: (path: string) => void | Promise<void>;
  /** Push one gate stage's console log to the panel; the `stage-log` message is the outcome. */
  requestStageLog: (stage: GateStage) => void | Promise<void>;
  /** Push one gate-lane AI process's console tail to the panel; the `agent-log` message is the outcome. */
  requestAgentLog: (processId: AgentProcessId) => void | Promise<void>;
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
  /** Apply a staged agent-core/model selection to this ticket's live session. */
  switchAgent: (provider: AgentProvider, model: string | null, effort: string | null) => void | Promise<void>;
  /** Copy the ticket key to the clipboard. */
  copyTicketKey: () => void | Promise<void>;
  /**
   * Clear a stage's block and try to drive it forward. Takes the message's
   * `ticketId`/`stageKey` VERBATIM (not pre-validated) so the host can apply
   * every check — same ticket, same current stage, actually blocked — in one
   * place, right against the store it is about to mutate.
   */
  resumeStage: (ticketId: number, stageKey: StageKey) => void | Promise<void>;
  /** Pause task execution for this panel's ticket (freeze all background driving). */
  pauseExecution: () => void | Promise<void>;
  /** Unpause (resume) task execution for this panel's ticket. */
  unpauseExecution: () => void | Promise<void>;
  /**
   * Switch one gate off (or on) for this ticket. Takes the stage and the gate
   * NAME — never a command or a script — so the webview can express only which
   * question to withdraw, never what to run.
   */
  setDisabledGate: (stage: GateStage, name: string, disabled: boolean) => void | Promise<void>;
  /**
   * Retry a gate stage by resetting it to pending so the driver re-runs it.
   * Takes the stage — narrowed to the two gate stages — so the webview can
   * only ask for a retry of a stage it can see. The host validates against
   * the ticket's current stage and status before touching the store.
   */
  rerunGate: (stage: GateStage) => void | Promise<void>;
  /**
   * Dispatch one opaque inside action id against the ticket's CURRENT action
   * registry. The host resolves the id; the webview cannot name a target.
   */
  insideAction: (actionId: string) => InsideActionResult | void | Promise<void>;
  /**
   * Open one artifact resource file. Takes the artifact id and the resource
   * INDEX (never a path): the host re-derives the artifacts and resolves the
   * index against the matched artifact's own resource list, so the webview
   * cannot name an arbitrary file to open.
   */
  openArtifactResource: (artifactId: string, index: number) => void | Promise<void>;
  /**
   * Change a spun ticket's base branch for one repository. Resolves to the
   * terminal outcome (UI-R13): `ok: false` means the change was REFUSED
   * (`dirty`/`conflict`/`base-missing`/`failed`) and nothing was touched —
   * `message` names git's own reason. `ok: true` means the base moved;
   * `message` reports what actually happened (rebased or not, PR retargeted
   * or not, merge check cleared) so the toast is never a generic "done".
   */
  changeBaseRef: (repo: string, baseRef: string, rebase: boolean) => Promise<InsideActionResult>;
}

/**
 * The synchronous, terminal outcome of one inside action dispatch (UI-R13).
 * The panel posts it verbatim as the `action-result` for the request, so a
 * rejected or stale dispatch is never acknowledged as a success. The rejection
 * reason itself stays host-side (it may name a path); `message` is the fixed
 * user-facing string.
 */
export interface InsideActionResult {
  ok: boolean;
  message?: string;
}

/** The terminal outcome of a `stage-log-request` (UI-R13). */
export type StageLogResult =
  | { kind: 'ok'; content: string; truncated: boolean }
  | { kind: 'error'; message: string };

/**
 * The gate-lane AI process whose console the terminal view can open: the UAT
 * Tester and the Review findings lane. A CLOSED vocabulary — the webview can
 * only name one of these two, never an arbitrary process id.
 */
export type AgentProcessId = 'tester' | 'review';

const AGENT_PROCESS_IDS: readonly string[] = ['tester', 'review'];

function isAgentProcessId(v: unknown): v is AgentProcessId {
  return typeof v === 'string' && (AGENT_PROCESS_IDS as readonly string[]).includes(v);
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
    case 'launch-worktree-extension':
      return path ? { type: 'launch-worktree-extension', path: m.path as string } : null;
    case 'open-pr':
      return isHttpUrl(m.url) ? { type: 'open-pr', url: m.url } : null;
    case 'copy-pr-url':
      return isHttpUrl(m.url) ? { type: 'copy-pr-url', url: m.url } : null;
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
    case 'pause-execution':
      return { type: 'pause-execution' };
    case 'unpause-execution':
      return { type: 'unpause-execution' };
    // Payload-free like the panel-level server controls: a companion field is
    // dropped, so the recovery can only ever move the ticket the panel owns.
    case 'send-back-to-implement':
      return { type: 'send-back-to-implement' };
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
    // The selection is re-validated host-side (isKnownProvider + model-choice
    // membership) before anything is confirmed or persisted, so the webview's
    // draft is a suggestion, never authority — but the two fields still pass
    // the trust boundary typed and bounded.
    case 'switch-agent': {
      const provider = typeof m.provider === 'string' ? m.provider : '';
      if (!isKnownProvider(provider)) return null;
      // A missing/blank model means "inherit"; a NON-string model drops the
      // whole message rather than being coerced to a value the webview never
      // offered.
      const model = m.model == null ? '' : (typeof m.model === 'string' ? m.model : null);
      if (model === null) return null;
      if (model.length > MAX_MODEL_ID_CHARS) return null;
      // Same contract for the effort/variant: absent/blank = inherit; a
      // non-string or oversized value drops the whole message.
      const effort = m.effort == null ? '' : (typeof m.effort === 'string' ? m.effort : null);
      if (effort === null) return null;
      if (effort.length > MAX_MODEL_ID_CHARS) return null;
      return { type: 'switch-agent', provider, model: model || null, effort: effort || null };
    }
    case 'copy-ticket-key':
      return { type: 'copy-ticket-key' };
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
    case 'artifact-open-resource': {
      // The id names an ARTIFACT (a bounded kind id), the index a RESOURCE of
      // that artifact — never a path or URL. Both are validated here, at the
      // boundary; the host re-derives the artifacts and resolves both against
      // them before opening anything, so a crafted message cannot aim the
      // editor at an arbitrary file.
      const artifactId = typeof m.artifactId === 'string' ? m.artifactId : '';
      if (artifactId.length === 0 || artifactId.length > MAX_ARTIFACT_ID_CHARS) return null;
      if (!/^[a-z0-9-]+$/.test(artifactId)) return null;
      if (!Number.isInteger(m.index) || (m.index as number) < 0) return null;
      return { type: 'artifact-open-resource', artifactId, index: m.index as number };
    }
    // The stage is narrowed to GATE_STAGES here, at the trust boundary; a
    // non-gate stage (or a malformed payload) drops the whole message.
    case 'stage-log-request':
      return isGateStage(m.stage) ? { type: 'stage-log-request', stage: m.stage } : null;
    // The process is narrowed to the closed AgentProcessId set; anything else
    // drops the whole message.
    case 'agent-log-request':
      return isAgentProcessId(m.processId)
        ? { type: 'agent-log-request', processId: m.processId }
        : null;
    // The stage is narrowed to GATE_STAGES; the key is a bounded, non-empty
    // string — no coercion. The host re-resolves both against the ticket's
    // actual attempt history before rendering anything.
    case 'select-gate-attempt': {
      const key = typeof m.key === 'string' ? m.key : '';
      return isGateStage(m.stage) && key.length > 0 && key.length <= MAX_GATE_ATTEMPT_KEY_CHARS
        ? { type: 'select-gate-attempt', stage: m.stage, key }
        : null;
    }
    // `repo` is the worktree's repoPath, matched like `resolve-conflicts`/
    // `merge-pr` (typed, non-empty, never trimmed — a path is not free text).
    // `baseRef` IS trimmed and must be non-blank: a blank base names nothing
    // to change to. `rebase` defaults ON when absent — the safe reading of a
    // missing switch (see the type's own doc).
    case 'change-base-ref': {
      const repo = typeof m.repo === 'string' ? m.repo : '';
      const baseRef = typeof m.baseRef === 'string' ? m.baseRef.trim() : '';
      if (repo.length === 0 || baseRef.length === 0) return null;
      return { type: 'change-base-ref', repo, baseRef, rebase: m.rebase !== false };
    }
    case 'rerun-gate':
      return isGateStage(m.stage) ? { type: 'rerun-gate', stage: m.stage } : null;
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

/** Longest artifact id accepted from a webview. Ids are kind ids (`uat-report`). */
export const MAX_ARTIFACT_ID_CHARS = 64;

/** Longest model id accepted from a webview. Real model ids are short CLI values; 128 is a bounded ceiling. */
const MAX_MODEL_ID_CHARS = 128;

/** Longest gate attempt key accepted from a webview. Real keys are short round identifiers. */
const MAX_GATE_ATTEMPT_KEY_CHARS = 64;

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
export function routeAction(
  raw: unknown,
  actions: DashboardActions,
): InsideActionResult | void | Promise<void> | Promise<InsideActionResult> {
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
    case 'launch-worktree-extension':
      return actions.launchWorktreeExtension(msg.path);
    case 'open-pr':
      return actions.openPr(msg.url);
    case 'copy-pr-url':
      return actions.copyPrUrl(msg.url);
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
    case 'send-back-to-implement':
      return actions.sendBackToImplement();
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
      return actions.switchAgent(msg.provider, msg.model, msg.effort);
    case 'copy-ticket-key':
      return actions.copyTicketKey();
    case 'stage-resume':
      return actions.resumeStage(msg.ticketId, msg.stageKey);
    case 'pause-execution':
      return actions.pauseExecution();
    case 'unpause-execution':
      return actions.unpauseExecution();
    case 'set-disabled-gates':
      return actions.setDisabledGate(msg.stage, msg.name, msg.disabled);
    case 'inside-action':
      return actions.insideAction(msg.actionId);
    case 'artifact-open-resource':
      return actions.openArtifactResource(msg.artifactId, msg.index);
    case 'stage-log-request':
      return actions.requestStageLog(msg.stage);
    case 'agent-log-request':
      return actions.requestAgentLog(msg.processId);
    case 'change-base-ref':
      return actions.changeBaseRef(msg.repo, msg.baseRef, msg.rebase);
    case 'rerun-gate':
      return actions.rerunGate(msg.stage);
  }
}
