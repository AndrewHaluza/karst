/**
 * PR description hygiene — the boundary between an agent's free-form answer and
 * public GitHub metadata.
 *
 * `describePr` asks an agent for prose and hands the answer straight to
 * `gh pr create --body`. An agent answering a chat-shaped question also emits
 * chat-shaped scaffolding: a status line about whether a PR exists yet, a "here
 * you go" preamble, an offer to revise, and — worst — the whole description
 * wrapped in a code fence "so it stands out", which renders the entire PR body
 * as one monospace block with no markdown at all.
 *
 * Two defenses, deliberately both: the prompt asks for a clean body, and the
 * sanitizer enforces it. The prompt is a request to a non-deterministic process;
 * the sanitizer is the only thing that holds when the request is ignored.
 */

/** The description request. Rules are explicit because the default answer is chat-shaped. */
export function buildPrDescriptionPrompt(title: string): string {
  return [
    `Write the pull-request description for the changes in this worktree.`,
    `Title: ${title}`,
    ``,
    `Output rules (strict):`,
    `- Output ONLY the description body: no preamble, no sign-off, no commentary about what you are doing, and no status line about whether a PR exists.`,
    `- Do not wrap the response in a code fence. Start directly with the description — a short summary line or a "## Summary" heading.`,
    `- Use GitHub-flavored markdown for structure and emphasis: headings, bullet lists, **bold**, and inline \`code\` for identifiers, file paths, commands, and flags.`,
    `- Use fenced code blocks only for real code, diffs, terminal output, or config snippets, and tag each fence with its language.`,
  ].join('\n');
}

/** Opening fence: three-or-more backticks/tildes plus an optional language tag. */
const FENCE_OPEN = /^(`{3,}|~{3,})([^\s`~]*)\s*$/;

/**
 * Fence tags that mean "this block is prose", so a fence carrying one around the
 * whole body is the bug, not a code block. Kept separate from the untagged case
 * only for readability — both are treated the same.
 */
const PROSE_TAGS = new Set(['', 'markdown', 'md', 'text', 'txt', 'plaintext']);

/**
 * Session/process commentary an agent wraps around an answer. Matched per line
 * and only at the top and bottom of the body — the same sentence can legitimately
 * appear as quoted terminal output in the middle of one, and edge-trimming needs
 * no fence tracking to get that right.
 */
const CHATTER = [
  /copy[\s-]*paste/i,
  /\bno (open )?(pr|pull request)\b.*\b(yet|for this branch)\b/i,
  /\bdescription (is )?below\b/i,
  /^here'?s\s+(the|a|your)\b.*\b(description|summary|body)\b/i,
  /^(below|the following) is\b.*\b(description|summary|body)\b/i,
  /^(pr|pull request) (body|description)\b.*\b(follows|below)\b/i,
  /^(let me know|feel free|hope (this|that) helps|anything else)\b/i,
  /^\(?(copy|paste) (this|the|it)\b/i,
];

interface Fence {
  readonly marker: string;
  readonly length: number;
  readonly tag: string;
}

function openingFence(line: string): Fence | null {
  const m = FENCE_OPEN.exec(line.trim());
  if (!m) return null;
  const run = m[1]!;
  return { marker: run[0]!, length: run.length, tag: m[2]!.toLowerCase() };
}

function closesFence(line: string, fence: Fence): boolean {
  const t = line.trim();
  return (
    t.length >= fence.length &&
    t.split('').every((c) => c === fence.marker) &&
    t.startsWith(fence.marker.repeat(fence.length))
  );
}

/**
 * Drop a fence that wraps the ENTIRE body — the "make it stand out" habit that
 * costs every heading, list, and inline code span its rendering. Repeats, because
 * a doubly wrapped body is one unwrap away from still being wrapped.
 *
 * Two shapes count as wrapped. The strict one: the fence's first closer IS the
 * last line. The loose one: the wrapper is tagged as prose (or untagged) and the
 * last line closes it — which is the common case, because an agent wrapping a
 * markdown body containing a ```bash block emits same-length nested fences, so
 * the first bare closer belongs to the inner block. Unwrapping there is still
 * right: a fence declaring its own contents to be markdown is prose wrapping.
 *
 * A fence tagged with a real language that closes before the last line is left
 * alone — that is a genuine code block with prose around it.
 */
function unwrapWholeBodyFence(text: string): string {
  let current = text.trim();
  for (let pass = 0; pass < 4; pass++) {
    const lines = current.split('\n');
    const first = lines[0];
    const last = lines[lines.length - 1];
    if (first === undefined || last === undefined || lines.length < 2) return current;
    const fence = openingFence(first);
    if (!fence) return current;

    const closeAt = lines.findIndex((line, i) => i > 0 && closesFence(line, fence));
    const wrapped =
      closeAt === lines.length - 1 ||
      (PROSE_TAGS.has(fence.tag) && closesFence(last, fence));
    if (!wrapped) return current;

    current = lines.slice(1, -1).join('\n').trim();
  }
  return current;
}

function isChatter(line: string): boolean {
  const t = line.trim();
  return t !== '' && CHATTER.some((re) => re.test(t));
}

/**
 * Peel commentary off the top and bottom, stopping at the first real line on each
 * side. Deliberately not a whole-body filter: chatter-shaped sentences are only
 * chatter when they frame the description. In the middle of a body the same text
 * is content — quoted terminal output, a note about the change — and deleting it
 * would silently edit what the agent actually reported.
 */
function trimChatterEdges(text: string): string {
  const lines = text.split('\n');
  let start = 0;
  let end = lines.length;
  while (start < end && (lines[start]!.trim() === '' || isChatter(lines[start]!))) start++;
  while (end > start && (lines[end - 1]!.trim() === '' || isChatter(lines[end - 1]!))) end--;
  return lines.slice(start, end).join('\n');
}

/**
 * Turn one agent answer into a PR body: no wrapping fence, no session chatter,
 * no ragged blank runs. `fallback` (the PR title) is used when nothing of
 * substance survives — an empty `--body` says less than the title does.
 */
export function sanitizePrDescription(raw: string, fallback: string): string {
  // Trimmed on both sides of the unwrap. Before, because the status line sits
  // OUTSIDE the wrapper fence and would otherwise hide the fact that line 1 opens
  // one; after, because the unwrap exposes the preamble the wrapper contained.
  const unwrapped = unwrapWholeBodyFence(trimChatterEdges(raw.trim()));
  const body = trimChatterEdges(unwrapped)
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return body || fallback;
}

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
