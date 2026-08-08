/**
 * The one place an AI integration point is named (§ token consumption stats).
 *
 * Token usage is attributed per call site, and the whole point of a single
 * closed set is that the attribution stays joinable: free-form strings scattered
 * across call sites produce a stats view whose rows can never be summed,
 * renamed, or ordered. Adding a new AI integration means adding ONE id here and
 * passing it as `tracking.callSite` — nothing else, by design (the recording
 * itself lives in `instrumentedAdapter.ts`, not at the call site).
 *
 * `unknown` is deliberate and is NOT a fallback the caller may pick: it is what
 * the instrumented adapter files a call under when it was made without
 * declaring a site. A new integration that forgets to declare one is therefore
 * still counted — visibly, under a name that reads as a defect — rather than
 * silently dropped from the totals.
 */

export const AI_CALL_SITES = [
  /** The ticket form's coupled ticket analyzer (prompt + approach + repos + type). */
  'ticket-analysis',
  /** The ticket form's per-repository signal-word suggestion. */
  'signal-suggestion',
  /** The ship stage asking for a PR body. */
  'pr-description',
  /**
   * The fix stage resuming a session to address failing gates — also the call
   * site of measured interactive deltas attributed to a Fix process (Task 5).
   */
  'fix-resume',
  /** Review's Lane B — asking an agent for structured findings over a target's diff. */
  'review-findings',
  /**
   * The impl stage's interactive Session process — the call site of measured
   * interactive deltas attributed to an implementation session (Task 5).
   */
  'implementation',
  /** An instrumented call that declared no site (see the module doc). */
  'unknown',
] as const;

export type AiCallSite = (typeof AI_CALL_SITES)[number];

/** The site an undeclared call is filed under. Never chosen by a call site. */
export const UNKNOWN_CALL_SITE: AiCallSite = 'unknown';

/** Type guard — the boundary check for an id read back out of the store/API. */
export function isAiCallSite(value: unknown): value is AiCallSite {
  return typeof value === 'string' && (AI_CALL_SITES as readonly string[]).includes(value);
}

/** Human label for one call site, for the stats view's rows. */
const LABELS: Record<AiCallSite, string> = {
  'ticket-analysis': 'Ticket analysis',
  'signal-suggestion': 'Signal suggestion',
  'pr-description': 'PR description',
  'fix-resume': 'Fix resume',
  'review-findings': 'Review findings',
  implementation: 'Implementation session',
  unknown: 'Undeclared',
};

export function aiCallSiteLabel(site: string): string {
  return isAiCallSite(site) ? LABELS[site] : site;
}
