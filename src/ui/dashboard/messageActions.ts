import type { StageKey } from '../../model/types.js';
import type { GateStage } from '../../store/ticketGates.js';
import type { AgentProvider } from '../../manifest/types.js';
import type { InsideActionResult, AgentProcessId } from './messages.js';

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
  startServer: (serverId: number) => void | Promise<void>;
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
  /** Open the Resource Monitor from a shared row's Manage action (no payload). */
  openResources: () => void | Promise<void>;
  /** Sandbox card (arch:AC-32): act on THIS panel's ticket only; the message carries no id. */
  sandboxSync: () => void | Promise<void>;
  sandboxDiff: () => void | Promise<void>;
  sandboxStop: () => void | Promise<void>;
  /** Guarded: syncs first and asks before dropping unsynced commits. */
  sandboxRemove: () => void | Promise<void>;
  sandboxCarry: () => void | Promise<void>;
  /** Stash the sandbox's uncommitted work, then update it from the host. */
  sandboxStashUpdate: () => void | Promise<void>;
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
  openDependency: (ticketId: number) => void | Promise<void>;
  stopDriver: () => void | Promise<void>;
  shipTicket: () => void | Promise<void>;
  resumeTicket: () => void | Promise<void>;
  /** Move this ticket back to Implement — the unified recovery action (host-confirmed). */
  sendBackToImplement: () => void | Promise<void>;
  /** Reset the failed gate stage and re-drive (host-confirmed). */
  resetStage: () => void | Promise<void>;
  /** Move this ticket into a PR-feedback recovery round at Fix (host-confirmed). */
  addressPrFeedback: () => void | Promise<void>;
  sendCiFailure: () => void | Promise<void>;
  rebaseOnBase: () => void | Promise<void>;
  /** Sync the sandbox, then ship's push onto the open PR ("Deliver to PR"). */
  deliverToPr: () => void | Promise<void>;
  /** Create a linked follow-up ticket from this (done) ticket. */
  createFollowUpTicket: () => void | Promise<void>;
  /** Create a sub-task under this ticket (host prompts for the title). */
  createSubtask: () => void | Promise<void>;
  /** Detach a sub-task from its parent: rebase onto parent's base and clear the parent link. */
  detachSubtask: () => void | Promise<void>;
  /** Close a ticket resolved outside karst; the host prompts for the reason. */
  closeTicket: () => void | Promise<void>;
  /** Reopen a closed ticket. */
  reopenTicket: () => void | Promise<void>;
  /** Open a stage's log (uat/review artifact) in an editor. Carries the stage key ONLY. */
  openStageLog: (stageKey: StageKey) => void | Promise<void>;
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
   * Dismiss one repo's PR — "this one will never land" — and re-settle the merge
   * gate. Takes the repo for the same reason `mergePr` does: the host resolves
   * the PR from the store and owns the confirmation.
   */
  dismissPr: (repo: string) => void | Promise<void>;
  /** Undo a dismissal, putting the PR back in the gate's way. */
  undismissPr: (repo: string) => void | Promise<void>;
  /**
   * Re-probe this ticket's PR statuses and mergeability immediately, bypassing
   * the sweep's freshness floor, and push the result. Takes nothing: the closure
   * already owns the ticket, and the panel is asking for "again", not "this one".
   */
  refreshPrs: () => void | Promise<void>;
  /**
   * Re-read this ticket's advisory ship preview and push the result. Takes
   * nothing: the closure owns the ticket, and the panel is asking for "again".
   */
  refreshShipPreview: () => void | Promise<void>;
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
  usageLimitPick: (ticketId: number, stageKey: StageKey) => void | Promise<void>;
  usageLimitRetry: (ticketId: number, stageKey: StageKey) => void | Promise<void>;
  usageLimitDismiss: (ticketId: number, stageKey: StageKey) => void | Promise<void>;
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
   * Save one scope of this ticket's env overrides. Takes the scope and the
   * `.env`-shaped body verbatim so the host can parse and validate both in one
   * place, right against the manifest and the store it is about to write.
   */
  saveEnvOverrides: (scope: string, text: string) => void | Promise<void>;
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
  /** Stored-artifact actions; the host re-validates every path and sha against the store. */
  openStoredRevision: (path: string, sha: string) => void | Promise<void>;
  diffStoredRevisions: (path: string, from: string, to: string) => void | Promise<void>;
  openStoredLive: (path: string) => void | Promise<void>;
  revealStoredFolder: () => void | Promise<void>;
  purgeStoredArtifacts: () => void | Promise<void>;
  /** Approve changed baselines by entry index; the host re-derives and validates (see the message). */
  baselineApprove: (blockId: string, indices: number[]) => void | Promise<void>;
  /** Reject one changed baseline with a reason; the host re-derives and validates. */
  baselineReject: (blockId: string, index: number, reason: string) => void | Promise<void>;
  /**
   * Change a spun ticket's base branch for one repository. Resolves to the
   * terminal outcome (UI-R13): `ok: false` means the change was REFUSED
   * (`dirty`/`conflict`/`base-missing`/`failed`) and nothing was touched —
   * `message` names git's own reason. `ok: true` means the base moved;
   * `message` reports what actually happened (rebased or not, PR retargeted
   * or not, merge check cleared) so the toast is never a generic "done".
   */
  changeBaseRef: (repo: string, baseRef: string, rebase: boolean) => Promise<InsideActionResult>;
  /** Open the combined server logs view. The `server-logs` message is the initial state. */
  requestServerLogs: () => void | Promise<void>;
  /** Close the combined server logs view and stop streaming. */
  closeServerLogs: () => void | Promise<void>;
  /**
   * Open this ticket's logs in the standalone panel. Optional: absent, the
   * "Open in Window" control is a no-op (the pre-feature panel). The panel
   * binds the ticket id, so the webview names no target.
   */
  onServerLogsDetach?: () => void | Promise<void>;
}
