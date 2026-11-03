// Planner bench prompt: the real planning instructions + a kickoff built from the public issue only.
// Never takes fix_patch or test_patch: the gold stays out of the planner's reach.
export const KICKOFF_LINE = 'No user is present. Propose the draft now.';

/** The kickoff text: the issue, then the one bench-only line (documented gap in @arch:FORMEVAL-PLAN). */
export function buildPlanKickoff({ title, body, extra = '' }) {
  const rules = extra ? `\n\n${extra}` : '';
  return `Plan this issue: ${title}\n\n${body}${rules}\n\n${KICKOFF_LINE}`;
}

/** Instructions ride the prompt, not the system channel: `RunHeadlessOpts` has no `instructions`. */
export function buildPlanPrompt({ instructions, title, body, kickoff = buildPlanKickoff({ title, body }) }) {
  return `${instructions}\n\n${kickoff}`;
}

/** One enabled repo at the checkout path: the smallest manifest `planningInstructions` accepts. */
export function buildPlanManifest(repo, checkout) {
  return { baselineBranch: 'main', repositories: { [repo]: { repoPath: checkout, enabled: true } } };
}
