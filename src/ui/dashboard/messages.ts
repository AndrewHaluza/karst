import type { StageKey } from '../../model/types.js';
import type { GateStage } from '../../store/ticketGates.js';
import type { AgentProvider } from '../../manifest/types.js';

/**
 * Webview → host action messages (§14 dashboard tier actions). The webview
 * posts these; the host routes them to daemon actions via `routeAction`.
 */
export type WebviewMessage =
  | { type: 'stop-server'; serverId: number }
  | { type: 'restart-server'; serverId: number }
  | { type: 'start-server'; serverId: number }
  | { type: 'open-server'; serverId: number }
  | { type: 'copy-server-url'; serverId: number }
  | { type: 'spin-servers' }
  | { type: 'restart-servers' }
  | { type: 'stop-servers' }
  /**
   * Open the window's Resource Monitor — the Manage action on a SHARED service
   * row, where starting or stopping is deliberately absent (a stop affects every
   * other ticket). The follow-up project view repoints this at `karst.openServers`.
   */
  | { type: 'open-resources' }
  | { type: 'sandbox-sync' }
  | { type: 'sandbox-diff' }
  | { type: 'sandbox-stop' }
  | { type: 'sandbox-remove' }
  | { type: 'sandbox-carry' }
  | { type: 'sandbox-stash-update' }
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
  | { type: 'open-dependency'; ticketId: number }
  | { type: 'stop-driver' }
  | { type: 'ship-ticket' }
  | { type: 'resume-ticket' }
  | { type: 'create-follow-up-ticket' }
  /**
   * Create a sub-task under this ticket (design NDL-70 §8). Payload-free like
   * `create-follow-up-ticket`: the host owns the parent id, the title prompt and
   * the writer's refusals. Never sent while the ticket ships or is done — the
   * host hides the control then and the writer refuses it anyway.
   */
  | { type: 'create-subtask' }
  /**
   * Detach a sub-task from its parent (design NDL-70 §5 'Detach'). Payload-free:
   * the host owns the ticket id and validates that it is a sub-task before
   * calling the detach workflow. Rebases onto the parent's base and clears the
   * parent link so the sub-task becomes top-level.
   */
  | { type: 'detach-subtask' }
  /**
   * Close / reopen a ticket resolved outside karst (`@arch:STAGEMACH`).
   * Payload-free by design: the host owns the ticket id and prompts for the
   * reason itself (the same `karst.closeTicket` command as the palette), so no
   * free text from the webview can reach the store.
   */
  | { type: 'close-ticket' }
  | { type: 'reopen-ticket' }
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
  /**
   * Enter a PR-feedback recovery round at Fix for the panel's ticket. Payload-
   * free like send-back: availability is re-derived host-side inside the
   * mutation's transaction, so the webview's claim is never trusted.
   */
  | { type: 'address-pr-feedback' }
  | { type: 'send-ci-failure' }
  | { type: 'rebase-on-base' }
  | { type: 'deliver-to-pr' }
  /**
   * Open a stage's recorded log (uat/review artifact) in an editor. Carries the
   * stage key ONLY, never a path: the host re-derives the artifact path from
   * the ticket it owns, so a crafted message cannot aim `Uri.file` at an
   * arbitrary local file.
   */
  | { type: 'open-stage-log'; stageKey: StageKey }
  | { type: 'resolve-conflicts'; repo: string }
  /**
   * Merge one repo's PR from the ship stage. Carries the repo ONLY: the merge
   * method is asked for host-side, in the confirmation the user must answer, so a
   * crafted (or stale) message can neither choose the strategy nor skip the
   * confirmation of an irreversible action.
   */
  | { type: 'merge-pr'; repo: string }
  /**
   * Declare that one repo's pull request will never land, so the merge gate
   * stops waiting on it — the escape hatch for a ticket parked at `ship` behind
   * a PR closed because the changes turned out to be unneeded (a closed PR can
   * never become 'merged', so the gate otherwise has no terminating answer).
   *
   * Carries the repo ONLY, exactly as `merge-pr` does: the host resolves the PR
   * from the store and puts the confirmation in front of the user, so a crafted
   * or stale message can neither name an arbitrary PR nor skip the confirm. It
   * is not a force-advance — the gate is re-read normally afterwards, so a
   * ticket with other unmerged PRs stays parked.
   */
  | { type: 'dismiss-pr'; repo: string }
  /** Undo a dismissal, putting the PR back in the merge gate's way. */
  | { type: 'undismiss-pr'; repo: string }
  /**
   * Re-probe this ticket's PRs and their mergeability NOW, instead of waiting for
   * the background sweep. Payload-free: which ticket (and which project) is the
   * host's to know, so a message cannot aim the probe at anything else.
   */
  | { type: 'refresh-prs' }
  /**
   * Re-read this ticket's advisory ship preview NOW, instead of waiting for the
   * next open or slot entry. Payload-free like `refresh-prs`: the host owns which
   * ticket the panel is for, so a crafted message cannot aim the read.
   */
  | { type: 'refresh-ship-preview' }
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
  /** Pick agent/model to resolve a usage-limit block (D159). */
  | { type: 'usage-limit-pick'; ticketId: number; stageKey: StageKey }
  /** Retry same agent/model to resolve a usage-limit block (D159). */
  | { type: 'usage-limit-retry'; ticketId: number; stageKey: StageKey }
  /** Dismiss a usage-limit block into a failed verdict and fix round (D159). */
  | { type: 'usage-limit-dismiss'; ticketId: number; stageKey: StageKey }
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
   * The Artifacts view's actions on the T2 store. They carry a store PATH
   * (`<repo>/<relPath>`) and revision SHAS — never a filesystem path: the host
   * re-resolves both against what the store holds (ops/storedArtifactOps.ts).
   */
  | { type: 'stored-artifact-open'; path: string; sha: string }
  | { type: 'stored-artifact-diff'; path: string; from: string; to: string }
  | { type: 'stored-artifact-live'; path: string }
  | { type: 'stored-artifact-reveal' }
  | { type: 'stored-artifact-purge' }
  /**
   * Approve changed baseline entries of the UAT report (@arch:BASELINE-REVIEW).
   * Carries the block id (`baseline-review`) and ENTRY INDICES — never a path or a hash: the
   * host re-derives the changed entries and resolves every index against them,
   * so a stale or crafted message approves nothing it cannot see as changed.
   */
  | { type: 'baseline-approve'; blockId: string; indices: number[] }
  /** Reject ONE changed baseline entry with the user's required reason. */
  | { type: 'baseline-reject'; blockId: string; index: number; reason: string }
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
   * Scope findings evidence to a single repository. `repo` is a recorded repo
   * value (a path), typed and non-empty, matched the way `change-base-ref`
   * matches its own repo — never trimmed, because a path is not free text. An
   * explicit `null` is the "all repositories" reset and is the ONLY non-string
   * this accepts. The host re-resolves the value against the batch it is about
   * to render.
   */
  | { type: 'select-findings-repo'; stage: GateStage; repo: string | null }
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
  | { type: 'rerun-gate'; stage: GateStage }
  /**
   * Open the combined server logs view for this ticket. Payload-free: the panel
   * closure already owns the ticket. The host reads all server log files and
   * answers with `server-logs`; live chunks follow as `server-log-output`.
   */
  | { type: 'server-logs-request' }
  /**
   * Close the combined server logs view and stop streaming. Payload-free: the
   * panel closure already owns the ticket. The host stops polling and clears
   * the reader state.
   */
  | { type: 'server-logs-close' }
  /**
   * Open this ticket's logs in the standalone server-logs editor panel. Sent
   * from the shared surface's "Open in Window" control. Payload-free: the panel
   * closure already owns the ticket, so a crafted message cannot aim the panel
   * at another one. The dashboard keeps its own in-panel view open.
   */
  | { type: 'server-logs-detach' }
  /**
   * Switch the active tab in the combined logs view. Carries the service name
   * of the server to focus, or 'merged' for the chronological interleaved view.
   */
  | { type: 'server-logs-tab'; tab: string }
  /**
   * Ask for the xterm bundle (first console open). Answered by the panel host
   * with an `xterm` message, never by a ticket action — see xtermAssets.ts.
   */
  | { type: 'xterm-request' }
  /**
   * Save ONE scope of this ticket's env overrides. `scope` is a manifest
   * repository name or `*` (every service); `text` is the `.env`-shaped body the
   * editor holds, parsed host-side by the SAME parser that reads a repository's
   * `.env` so the two can never disagree about quoting. Payload-free of a ticket
   * id: the panel closure already owns it, and the host validates the scope
   * against the ticket's own runnable repositories before writing.
   */
  | { type: 'env-overrides-save'; scope: string; text: string };

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

export type { ServerLogEntry, HostMessage } from './messageHost.js';
export type { DashboardActions } from './messageActions.js';
export { MAX_ACTION_ID_CHARS, MAX_ARTIFACT_ID_CHARS } from './messageValidate.js';
export { parseWebviewMessage, parseInsideProgress } from './messageParse.js';
export { routeAction } from './messageRoute.js';
