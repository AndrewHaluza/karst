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
 * names no product, no branch and no gate of its own; the base ref and the
 * passed-gate names are the caller's facts, injected. That reconnaissance is paid
 * for in tokens and wall clock BEFORE a single line of the diff is read, and
 * every fact it recovers is already known to the host: the worktree IS the
 * ticket's checkout, it IS on the right branch, and its base ref is passed in.
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
   * Deterministic gates that already ran and PASSED, by name. Naming them is
   * what stops the Tester from re-running the suite the stage just ran: the
   * gates are the cheap deterministic half and they are already done.
   */
  gatesPassed?: readonly string[];
}

/** The diff command the agent should use — the exact range, never a guess. */
function diffCommand(baseRef?: string | null): string {
  return baseRef
    ? `git diff origin/${baseRef}...HEAD (fall back to \`git diff ${baseRef}...HEAD\` if the remote ref is absent)`
    : `git diff <base-branch>...HEAD`;
}

/**
 * The orientation + scope lines. Returns the block as an array of lines so
 * each caller joins it into its own prompt layout.
 */
export function buildScopeBlock(intent: ScopeIntent, opts: ScopeBlockOpts = {}): string[] {
  const subject = intent === 'review' ? 'review' : 'test';
  const gates = opts.gatesPassed ?? [];
  const gateLine =
    gates.length > 0
      ? [
          `- The deterministic gates already ran and PASSED: ${gates.join(', ')}. Do NOT re-run them — ` +
            `spend your time on behavior they cannot check.`,
        ]
      : [];
  return [
    `Orientation (already established — do NOT re-derive it):`,
    `- Your working directory IS this ticket's worktree, already checked out on the correct branch.`,
    `- The changes to ${subject} are exactly: \`${diffCommand(opts.baseRef)}\` plus any uncommitted work (\`git status --porcelain\`).`,
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
