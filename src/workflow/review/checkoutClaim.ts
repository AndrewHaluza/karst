/**
 * The one claim a review agent makes that the HOST can check for itself.
 *
 * `agentScope.ts` names the ticket's branch and tells the agent to stop and
 * report a critical "wrong checkout" if `git rev-parse --abbrev-ref HEAD` prints
 * anything else. That rule exists because a silent empty diff is worse than a
 * loud stop — but it hands a blocking verdict to whatever the agent BELIEVES it
 * saw, and a weak model that mis-reads its own orientation check blocks a ticket
 * over code it never read (the observed case: a worktree provably on the ticket
 * branch, reported as `develop`, blocking review while every deterministic gate
 * passed).
 *
 * Every other finding is a judgement the host cannot second-guess. This one is a
 * FACT about the filesystem, and the host holds both halves of it: the worktree
 * path it launched the agent in, and `worktrees.branch`, authoritative since
 * creation. So it asks git, and a claim git DISPROVES is dropped.
 *
 * The asymmetry is deliberate: only a proven `matches` drops the claim. A
 * checkout that really differs, or a probe that cannot answer, leaves the
 * finding exactly where it was — the failure this guard must never cause is
 * swallowing a real wrong-checkout report.
 */

import type { GitRunner } from '../../integrations/git.js';
import type { FindingInput } from '../../store/reviewFindings.js';
import type { WarnFn } from './findings.js';

/** What the host could establish about a target's checkout. */
export type CheckoutVerdict =
  /** HEAD is provably the ticket's branch — an agent's contrary claim is false. */
  | 'matches'
  /** HEAD is provably some other branch — the agent was right. */
  | 'differs'
  /** git could not answer. NEVER read as proof; the claim stands. */
  | 'unknown';

/**
 * Is this the wrong-checkout claim `agentScope.ts` asks for?
 *
 * Matched on the TITLE the scope block dictates, whitespace- and case-normalized
 * (the instruction gives the exact words, and models vary the casing), and
 * matched WHOLE: a finding merely discussing checkout logic is an ordinary
 * finding and must survive untouched.
 */
export function isWrongCheckoutClaim(finding: Pick<FindingInput, 'title'>): boolean {
  return finding.title.trim().replace(/\s+/g, ' ').toLowerCase() === 'wrong checkout';
}

/**
 * Ask git which branch the worktree is on. Never throws: this runs inside a
 * review that has already done its work, and a probe that fails must degrade to
 * `unknown` rather than take the run down with it.
 */
export async function verifyCheckout(
  git: GitRunner,
  worktreePath: string,
  branch: string,
): Promise<CheckoutVerdict> {
  try {
    const result = await git(['rev-parse', '--abbrev-ref', 'HEAD'], worktreePath);
    if (result.exitCode !== 0) return 'unknown';
    const head = result.stdout.trim();
    // A detached HEAD prints `HEAD`, which is neither the branch nor a proof of
    // anything — `differs` is the honest reading, and it keeps the claim.
    if (head === '') return 'unknown';
    return head === branch.trim() ? 'matches' : 'differs';
  } catch {
    return 'unknown';
  }
}

export interface DropClaimContext {
  /** The ticket's branch, as `worktrees.branch` holds it. */
  branch: string;
  /** The target repository, for the reported line. */
  repo: string;
  warn?: WarnFn;
}

/**
 * Drop wrong-checkout claims the host has DISPROVEN, and report each one.
 *
 * Returns a new array; the input is never mutated. Reported rather than silent:
 * a dropped critical the user cannot see is indistinguishable from a finding
 * karst lost, and this guard has to stay auditable precisely because it removes
 * something blocking.
 */
export function dropDisprovenCheckoutClaims(
  findings: readonly FindingInput[],
  verdict: CheckoutVerdict,
  ctx: DropClaimContext,
): FindingInput[] {
  if (verdict !== 'matches') return [...findings];
  const kept = findings.filter((f) => !isWrongCheckoutClaim(f));
  if (kept.length !== findings.length) {
    ctx.warn?.(
      `review findings: ${ctx.repo} — dropped a "wrong checkout" finding. The agent reported it, ` +
        `but this worktree is on '${ctx.branch}', which is the ticket's branch; the claim is false ` +
        `and would have blocked the ticket over a diff the agent did read.`,
    );
  }
  return kept;
}
