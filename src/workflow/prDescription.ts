/** Bounded branch facts collected for a deterministic PR description. */
export interface PrDiffContext {
  /** One-line summaries of commits unique to the shipped branch. */
  commits?: string;
  /** True when the commit list was cut to its cap. */
  commitsTruncated?: boolean;
  /** `git diff --stat` output for the pull-request comparison. */
  diffStat?: string;
  /** True when the diffstat was cut to its cap. */
  diffStatTruncated?: boolean;
}

/** Everything the local PR-description renderer needs. */
export interface PrDescriptionContext extends PrDiffContext {
  /** The final PR title. */
  title: string;
  /** Repository metadata retained for callers/templates and future formatting. */
  repo?: string;
  branch?: string;
  baseRef?: string;
}

function commitBullet(line: string): string | null {
  const summary = line
    .trim()
    .replace(/^\*\s+/u, '')
    .replace(/^[0-9a-f]{7,64}\s+/iu, '')
    .trim();
  return summary === '' ? null : `- ${summary}`;
}

/**
 * Build public GitHub prose from branch-local git facts. No agent participates:
 * ship already has the exact metadata, while a tool-capable agent adds latency,
 * token spend, and an opportunity to inspect a different project.
 */
export function renderPrDescription(ctx: PrDescriptionContext): string {
  if (!ctx.commits && !ctx.diffStat) return ctx.title;

  const parts = ['## Summary', '', ctx.title];
  const commits = ctx.commits
    ?.split(/\r?\n/u)
    .map(commitBullet)
    .filter((line): line is string => line !== null);
  if (commits && commits.length > 0) {
    parts.push('', `## Changes${ctx.commitsTruncated ? ' (truncated)' : ''}`, '', ...commits);
  }
  if (ctx.diffStat) {
    parts.push(
      '',
      `## Changed files${ctx.diffStatTruncated ? ' (truncated)' : ''}`,
      '',
      '```text',
      ctx.diffStat,
      '```',
    );
  }
  return parts.join('\n');
}
