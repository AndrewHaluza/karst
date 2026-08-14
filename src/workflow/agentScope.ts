/**
 * The ORIENTATION block every gate-lane agent prompt carries (UAT Tester,
 * Review findings lane).
 *
 * Both lanes drop a headless agent into a worktree with a two-line request and
 * nothing else, so the agent's first move is to work out where it is: `git
 * status`, `git branch -vv`, `git log`, `git worktree list` (which scales with
 * however many worktrees the checkout has accumulated, none of them this
 * ticket's), and — wherever the target repo's own instructions mention one —
 * orchestrator CLI/registry queries. The block is
 * deliberately TOOL-AGNOSTIC prose: karst drives arbitrary projects, so it
 * names no product and no gate of its own; the base ref, the ticket's BRANCH
 * and the passed-gate names are the caller's facts, injected. That reconnaissance is paid
 * for in tokens and wall clock BEFORE a single line of the diff is read, and
 * every fact it recovers is already known to the host: the worktree IS the
 * ticket's checkout, its BRANCH is on the worktree row (`worktrees.branch`,
 * authoritative since creation), and its base ref is passed in.
 *
 * The branch is NAMED, not asserted, because "your working directory IS the
 * ticket's worktree, already on the right branch" was a promise nothing
 * enforced: a checkout adopted by path on another branch (or a session started
 * in the main checkout) made `git diff origin/<base>...HEAD` read as NO
 * changes while the ticket's branch held the real diff (fu1). Naming the
 * branch turns that silent empty diff into the actual changes: `git diff
 * origin/<base>...<branch>` resolves the branch BY NAME, so it is the same
 * answer from any checkout of the repo, and the agent may confirm its
 * location with exactly one `git rev-parse --abbrev-ref HEAD`.
 *
 * So the block STATES those facts and forbids re-deriving them. It is
 * deliberately a prompt-level fix and nothing more: the stage ordering was
 * already gates-then-agent (`stages/uat.ts` runs the Tester only after the
 * required gates pass; `stages/review.ts` runs the lane after its gates), so
 * there is no execution order to change — only the agent's own first step.
 *
 * The block is appended AFTER the strategy lines (which a user's own
 * `instructions` may replace) and BEFORE the output rules, and is never
 * replaceable: an author overriding the strategy is choosing WHAT to look for,
 * not licensing a repo-wide sweep.
 */

/** What the agent is being pointed at — the two lanes word this differently. */
export type ScopeIntent = 'review' | 'test';

export interface ScopeBlockOpts {
  /** The plain base branch name (`worktrees.base_ref`), when known. */
  baseRef?: string | null;
  /**
   * The ticket's own branch (`worktrees.branch`), when known. Naming it makes
   * the diff range `origin/<base>...<branch>` — correct from ANY checkout of
   * the repo, not just the ticket worktree — and lets the agent confirm its
   * location with one `git rev-parse --abbrev-ref HEAD`. Absent → fall back to
   * `...HEAD` (a checkout that can read "no changes" when it is not on the
   * ticket's branch).
   */
  branch?: string | null;
  /**
   * Deterministic gates that already ran and PASSED, by name. Naming them is
   * what stops the Tester from re-running the suite the stage just ran: the
   * gates are the cheap deterministic half and they are already done.
   */
  gatesPassed?: readonly string[];
}

/**
 * The diff line the agent should start from — the exact range, never a guess.
 * Returned as a whole line rather than a bare command because the fallback ref
 * needs its own code span: nesting one backtick pair inside another produced a
 * mangled span, and a range the agent has to un-mangle is the guess this block
 * exists to remove.
 */
function diffLine(subject: string, baseRef?: string | null, branch?: string | null): string {
  // The head is origin/<branch> when known (resolves against the remote state,
  // so a stale local ref never produces an empty diff), else the checkout's
  // HEAD. A branch-named range resolves the ref itself, so it is the same diff
  // from any checkout of the repo — a worktree (or session) sitting on the base
  // branch reads the ticket's actual changes instead of an empty diff.
  const head =
    branch && branch.trim() !== '' ? `origin/${branch}` : 'HEAD';
  const range = baseRef
    ? `\`git diff origin/${baseRef}...${head}\` (or \`git diff ${baseRef}...${branch ?? 'HEAD'}\` when the remote ref is absent)`
    : `\`git diff <base-branch>...${head}\``;
  return `- The changes to ${subject} are exactly: ${range}, plus any uncommitted work (\`git status --porcelain\`).`;
}

/**
 * The orientation + scope lines. Returns the block as an array of lines so
 * each caller joins it into its own prompt layout.
 */
export function buildScopeBlock(intent: ScopeIntent, opts: ScopeBlockOpts = {}): string[] {
  const subject = intent === 'review' ? 'review' : 'test';
  const gates = opts.gatesPassed ?? [];
  const branch = opts.branch?.trim() || null;
  const gateLine =
    gates.length > 0
      ? [
          `- The deterministic gates already ran and PASSED: ${gates.join(', ')}. Do NOT re-run them — ` +
            `spend your time on behavior they cannot check.`,
        ]
      : [];
  // Name the branch and grant the ONE self-check that detects a wrong
  // checkout, instead of asserting "already on the correct branch" — a
  // promise the host could not keep, and one the agent must not swallow: a
  // silent empty `git diff origin/<base>...HEAD` reads as "no changes" while
  // the ticket's branch carries the real diff. The diff range uses
  // `origin/<branch>` so it resolves against the remote state (a stale local
  // ref never produces an empty diff); the rev-parse is only to confirm where
  // the agent is.
  const orientation =
    branch !== null
      ? `- This ticket's branch is \`${branch}\`. Confirm you are in the right checkout with \`git rev-parse --abbrev-ref HEAD\` (it should print that branch); the diff range below names the branch, so it reads the same from any checkout.`
      : `- Your working directory IS this ticket's worktree, already checked out on the correct branch.`;
  return [
    `Orientation (already established — do NOT re-derive it):`,
    orientation,
    diffLine(subject, opts.baseRef, branch),
    ...gateLine,
    ``,
    `Scope rules (strict):`,
    `- Start by reading that diff. Do not survey the repository first.`,
    `- Do NOT run repository-wide reconnaissance: no \`git worktree list\`, no branch/remote mapping, ` +
      `no \`git log\` over history outside the diff range, no querying the orchestration tool that ` +
      `launched you (its CLI or its state database), no reading other worktrees or checkouts.`,
    `- Widen beyond the diff only into a file the diff actually touches or directly calls, and only when a specific question requires it.`,
  ];
}
