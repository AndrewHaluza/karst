/**
 * Shared vocabulary — load-bearing types referenced everywhere (§5.4, §14).
 * Define once here; every consumer imports from this module.
 */

/**
 * Stage identity — the graph nodes (§11). `fetch` is NOT a runtime stage in MVP
 * (decision C1): tickets are created manually and seed directly at `scope`.
 * When provider fetch lands post-MVP, prepend `fetch`.
 *
 * `closed` is the one key that is NOT in `STAGE_KEYS`: it is an operator exit
 * (the work was resolved outside karst), entered only by `closeTicket`, never by
 * a verdict, and never seeded or drawn as a rail step.
 */
export type StageKey =
  | 'scope'
  | 'impl'
  | 'uat'
  | 'review'
  | 'fix'
  | 'ship'
  | 'done'
  | 'closed';

/**
 * Per-stage lifecycle status (§6 stages.status).
 *
 * `bypassed` is the outcome of a gate stage (uat/review) whose every gate the
 * user switched off for this ticket: the stage did not gate, so it is NOT
 * `passed`, and it did not park either — the pipeline continues. It is a
 * deliberate skip, distinct from `skipped` (a stage that never ran) and from a
 * real gate pass: no gate outcome was proven, only that the user disabled them.
 */
export type StageStatus = 'pending' | 'running' | 'passed' | 'failed' | 'skipped' | 'bypassed';

/**
 * Agent liveness, driven ONLY by hooks (§5.4, §5.6) — orthogonal to StageStatus.
 * `waiting` is the needs-you signal (amber glyph); it never comes from stage state.
 *
 * `not-started` is the launch-delivery guard's own signal (v68): a prepared
 * launch stayed `pending` past its delivery window, so no SessionStart ever
 * confirmed it and the agent never received its brief. It reads amber "Needs
 * you" like `waiting`, and is cleared the moment the intent confirms (a
 * SessionStart writes `running`).
 */
export type AgentState = 'running' | 'waiting' | 'idle' | 'none' | 'not-started';

/**
 * The transition currency (§5.4). A transition REQUIRES a definite verdict;
 * `null` means "no verdict yet" and MUST NOT cause a transition
 * (the no-inference guarantee).
 *
 * `bypassed` is definite: every gate of a gate stage (uat/review) was
 * deliberately disabled for this ticket, so the stage could not ask its
 * question at all. It takes the same forward edge as `passed` — the pipeline
 * continues — but the stage row records `bypassed`, never `passed`: the user
 * chose to skip the check, so no gate outcome was proven.
 */
export type Verdict =
  | { kind: 'passed' }
  | { kind: 'failed'; reason?: string }
  | { kind: 'bypassed' }
  | null;

/** The ordered set of MVP stages, for seeding a ticket's stage rows. */
export const STAGE_KEYS: readonly StageKey[] = [
  'scope',
  'impl',
  'uat',
  'review',
  'fix',
  'ship',
  'done',
] as const;

/** Every key a stored `stage_current` may hold: the rail plus the `closed` exit. */
export const ALL_STAGE_KEYS: readonly StageKey[] = [...STAGE_KEYS, 'closed'];

/**
 * Whether a stored `stage_current` has no more work: `done` (delivered) or
 * `closed` (resolved outside karst). Takes the raw stored string, which may be
 * null or from another schema. Use for "is this ticket over?" decisions; keep
 * `=== 'done'` where the meaning is "delivered" (follow-ups, done-entry side
 * effects, the auto-archive clock).
 */
export function isFinishedStage(stage: string | null | undefined): boolean {
  return stage === 'done' || stage === 'closed';
}

/**
 * Why karst could not ask a stage's question. Distinct from a `failed` verdict:
 * `failed` means the code is wrong and an agent can act; a blocker is
 * environmental — a human frees the port, installs the binary, fixes the config.
 *
 * `attempts-exhausted` is deliberately NOT here: it is entirely about attempts
 * consumed, it does mean the code is wrong, and its resting place (the ticket sits
 * at `fix`, unswept) already exists and needs no state.
 */
export type BlockerKind =
  | 'nothing-to-run'        // Phase 1: every gate returned null
  | 'capability-missing'    // Phase 1: permission/IO error; Phase 2: Playwright, auth digest
  | 'no-independent-signal' // Phase 2 only — a warning in Phase 1
  // UAT could not bring the ticket's services up before the Tester (D155): a
  // service never became healthy (nothing listening, or a listener that never
  // answered), so the app the Tester would exercise does not exist. An
  // ENVIRONMENT fault, never a verdict about the code — a failed verdict here
  // would route to fix and spend a round on nothing. The reason carries the
  // start failure's health evidence plus the service's log tail; a generic
  // Resume re-drives uat and retries the spin.
  | 'boot-failed'
  | 'lease-lost'            // Phase 2
  // Not "karst could not ask" like the rest of this union — the question WAS
  // asked (ship opened its PRs) and answered "not yet". Reused here because it
  // shares the exact plumbing (`stages.blocked_*`, stageBlocks.ts) that a
  // parked-on-a-human-action stage needs, and a second column set would just
  // duplicate it. Entered on ship's own pass (workflow/mergeGate.ts), cleared
  // the moment every PR it opened reads merged.
  | 'awaiting-merge'
  // Same shape as `awaiting-merge`: the question WAS asked — UAT's gates passed
  // and a ticket-changed baseline image (@arch:BASELINE-REVIEW) now waits for
  // the USER's Approve/Reject in the UAT report. Not "karst could not ask": a
  // retry cannot decide for the user, so Resume is refused and only a recorded
  // decision (approve-all → re-drive, reject → failed verdict) clears it.
  | 'baseline-review'
  // Review keeps finding new blocking problems in the same file(s) round after
  // round (`review.stallDetection`) — a likely design problem, not a bug. Karst
  // stops opening fix rounds and asks the human; the question WAS asked, so a
  // generic Resume is refused and only Redesign hint / Continue anyway /
  // Re-scope clear it (@arch:BLOCKED). Parked at `fix`, never a verdict.
  | 'review-stalled'
  // A worktree whose `repo` matched no `repositories:` entry in karst.yml.
  // Also not "karst could not ask": the question was asked of the manifest and
  // answered "this repository is not mapped" — a retry cannot change that
  // answer, only the user editing karst.yml or re-scoping the ticket can, so a
  // retry only helps AFTER the user fixes karst.yml — which is exactly what the
  // Resume button is for, so the block stays resumable.
  | 'unmapped-repository'
  // The implementation GRAPH blocked (Slice-3 T9): a node failed with
  // `resource-claim-violated` or `integration-conflict`, or termination could
  // not be proven. The generic Resume MUST NOT clear it — the graph needs
  // graph-aware recovery (retry/recompile/replan), and clearing the block
  // stranding the graph's stage signal is the same failure class as clearing
  // `awaiting-merge`. `needsUser` renders it amber; Resume returns the typed
  // `graph-recovery` action instead.
  | 'approach-graph-failed'
  // Same shape as `awaiting-merge`: not "karst could not ask" — the graph's
  // own work finished (`completed-awaiting-impl-marker`) and is waiting on a
  // human or agent to fire `karst stage impl pass`. The impl stage row itself
  // stays `running` (the driver never re-infers a verdict from graph state),
  // so this is the ONLY signal `needsUser` has to read the wait as amber
  // instead of the ticket silently reading as if nothing were happening.
  // Written by `workflow/graphMarkerGuard.ts`'s `markGraphAwaitingImplMarker`
  // the moment the graph flips quiescent, cleared the moment the marker fires.
  | 'awaiting-impl-marker'
  // A parent held by its own sub-tasks (design NDL-70 §5, D5). Same shape as
  // `awaiting-merge`: the question was asked and the answer was "not yet", so
  // it is NOT "karst could not ask". `leave-impl` parks a parent whose blocking
  // sub-tasks are not done; `ship` parks a parent whose started stacks have not
  // landed. The reason lists the sub-task keys and stages. `needsUser` reads it
  // as waiting, never amber — the wait is on a machine or another ticket.
  | 'awaiting-subtask'
  // A parent whose local branch could not absorb a landed sub-task's work
  // (design NDL-70 §6). Unlike `awaiting-subtask`, this DOES need a human: the
  // automatic `--no-edit` merge conflicted and was aborted, so the parent's
  // worktree is untouched and its stage is parked. The reason names the
  // sub-task and the conflicting files.
  | 'subtask-integration-conflict'
  // The provider refused because the ACCOUNT is out of quota/allowance (K11,
  // D158). Same shape as `awaiting-merge`: the question WAS asked and answered
  // "not now" — a retry cannot make a quota reset, so a generic Resume is
  // refused (the user must pick another agent/model, or retry once the limit
  // resets). Written by `parkGateStage` (review/UAT) and by the op-park helper
  // (every other AI op); the reason carries the provider/model that exhausted.
  | 'usage-limit'
  // A gate stage read `running` with no stage run and no process run behind it,
  // and one re-drive did not start it (`sweepStrandedStages`). The question was
  // never asked; Resume re-drives the stage.
  | 'stranded-stage'
  // The driver could not bring the sandbox in sync with the host branch
  // (`sandbox-sync`: divergence, or uncommitted sandbox work with the host
  // ahead) or could not provision it (`sandbox-setup`). The gates never ran.
  // Environmental and resumable: Resume re-drives and retries the sync.
  | 'sandbox-sync'
  | 'sandbox-setup';

/**
 * What one stage run did. A runner no longer implies a transition by returning:
 * it says whether it advanced the ticket, could not ask the question at all, or
 * was stopped. `blocked` and `stopped` both mean no verdict and no attempt.
 */
export type StageRunResult =
  | { kind: 'advanced'; next: StageKey }
  | { kind: 'blocked'; blocker: BlockerKind; reason: string }
  | { kind: 'stopped' };
