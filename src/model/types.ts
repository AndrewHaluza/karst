/**
 * Shared vocabulary — load-bearing types referenced everywhere (§5.4, §14).
 * Define once here; every consumer imports from this module.
 */

/**
 * Stage identity — the graph nodes (§11). `fetch` is NOT a runtime stage in MVP
 * (decision C1): tickets are created manually and seed directly at `scope`.
 * When provider fetch lands post-MVP, prepend `fetch`.
 */
export type StageKey =
  | 'scope'
  | 'impl'
  | 'uat'
  | 'review'
  | 'fix'
  | 'ship'
  | 'done';

/** Per-stage lifecycle status (§6 stages.status). */
export type StageStatus = 'pending' | 'running' | 'passed' | 'failed' | 'skipped';

/**
 * Agent liveness, driven ONLY by hooks (§5.4, §5.6) — orthogonal to StageStatus.
 * `waiting` is the needs-you signal (amber glyph); it never comes from stage state.
 */
export type AgentState = 'running' | 'waiting' | 'idle' | 'none';

/**
 * The transition currency (§5.4). A transition REQUIRES a definite verdict;
 * `null` means "no verdict yet" and MUST NOT cause a transition
 * (the no-inference guarantee).
 */
export type Verdict =
  | { kind: 'passed' }
  | { kind: 'failed'; reason?: string }
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
  | 'boot-failed'           // Phase 2
  | 'lease-lost'            // Phase 2
  // Not "karst could not ask" like the rest of this union — the question WAS
  // asked (ship opened its PRs) and answered "not yet". Reused here because it
  // shares the exact plumbing (`stages.blocked_*`, stageBlocks.ts) that a
  // parked-on-a-human-action stage needs, and a second column set would just
  // duplicate it. Entered on ship's own pass (workflow/mergeGate.ts), cleared
  // the moment every PR it opened reads merged.
  | 'awaiting-merge'
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
  | 'awaiting-impl-marker';

/**
 * What one stage run did. A runner no longer implies a transition by returning:
 * it says whether it advanced the ticket, could not ask the question at all, or
 * was stopped. `blocked` and `stopped` both mean no verdict and no attempt.
 */
export type StageRunResult =
  | { kind: 'advanced'; next: StageKey }
  | { kind: 'blocked'; blocker: BlockerKind; reason: string }
  | { kind: 'stopped' };
