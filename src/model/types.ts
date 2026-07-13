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
