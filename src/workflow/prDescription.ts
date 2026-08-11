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
 * Two defenses, deliberately both: the prompt asks for a clean body AND hands
 * the model the actual change material (commits, diffstat, diff — see
 * `prDiffContext.ts`), and the sanitizer enforces the clean body. The prompt is
 * a request to a non-deterministic process; the sanitizer is the only thing
 * that holds when the request is ignored. The material is what keeps the model
 * from exploring the worktree — a run told only "describe the changes" once
 * answered "where is the worktree located?" and that help-request shipped as
 * the PR body (869ef1e6x, PR #117).
 */

import type { Store } from '../store/db.js';
import { latestStageRun, previousStageRun } from '../store/stageRuns.js';

/**
 * Whether any gate stage's latest run resolved a different gate set than the
 * run before it. Both runs must have recorded a hash — a null on either side
 * is "unknown", never "changed" — and a run with no predecessor cannot differ
 * from one (RC5: a gate removed from the manifest must not read as a gate that
 * was fixed; the PR body says so when it happened).
 */
export function gateSetChangedSincePreviousRun(store: Store, ticketId: number): boolean {
  for (const stageKey of ['uat', 'review'] as const) {
    const latest = latestStageRun(store, ticketId, stageKey);
    if (latest === null) continue;
    const prior = previousStageRun(store, latest);
    if (prior === null) continue;
    if (
      latest.manifestHash !== null &&
      prior.manifestHash !== null &&
      latest.manifestHash !== prior.manifestHash
    ) {
      return true;
    }
  }
  return false;
}

function section(name: string, body: string | undefined): string | null {
  return body === undefined || body === '' ? null : `${name}\n${body}`;
}

/**
 * The description request. Rules are explicit because the default answer is
 * chat-shaped — and the material is explicit because a model handed nothing
 * but a title goes exploring for the changes, which is how a help-request
 * ("where is the worktree?") became a PR body. Everything the model needs is
 * in the prompt; it is told never to go and get more.
 */
export function buildPrDescriptionPrompt(ctx: PrDescriptionContext): string {
  const line = (label: string, value: string | undefined): string | null =>
    value === undefined || value === '' ? null : `${label}: ${value}`;

  const parts = [
    'Write the pull-request description for the changes below.',
    line('Repository', ctx.repo),
    line(
      'Branch',
      ctx.branch && ctx.baseRef ? `${ctx.branch} → ${ctx.baseRef}` : (ctx.branch ?? ctx.baseRef),
    ),
    line('Title', ctx.title),
    section('Commits on this branch:', ctx.commits),
    section('Changed files (diffstat):', ctx.diffStat),
    ctx.diff === undefined
      ? null
      : section(
          `Diff (${ctx.diffTruncated ? 'truncated — commits and diffstat above are complete' : 'full'}):`,
          ctx.diff,
        ),
    '',
    'Output rules (strict):',
    `- Base the description ONLY on the material above. Do not run commands, open files, or inspect the repository — everything you need is included.`,
    `- Output ONLY the description body: no preamble, no sign-off, no commentary about what you are doing, and no status line about whether a PR exists.`,
    `- Do not wrap the response in a code fence. Start directly with the description — a short summary line or a "## Summary" heading.`,
    `- Use GitHub-flavored markdown for structure and emphasis: headings, bullet lists, **bold**, and inline \`code\` for identifiers, file paths, commands, and flags.`,
    `- Use fenced code blocks only for real code, diffs, terminal output, or config snippets, and tag each fence with its language.`,
    ...(ctx.gateSetChanged
      ? [
          ``,
          `The gate set for this ticket changed since the previous attempt of a gate stage — a gate may have been removed rather than fixed.`,
          `State this in the description so a deleted gate cannot read as a fixed one.`,
        ]
      : []),
  ];
  return parts.filter((p): p is string => p !== null).join('\n');
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

/**
 * Exploration and help-request narration — a model told nothing about the
 * changes went looking for them, announced every step, and asked where they
 * were. A run told only a title once shipped "The current directory (/) is not
 * a git repository. Where is the worktree located?" as the PR body (PR #117).
 * These phrases are high-precision enough to also be cut from the START of a
 * line when they glued onto real content ("Found the worktree. Let me examine
 * the changes.## Summary" is one line in the wild, and dropping the whole line
 * would take the heading with it).
 */
const CHATTER_PREFIX = [
  /^found the worktree/i,
  /^the current directory .*? is (not|n'?t) a git repository/i,
  /^where (is|are|was|were) (the|my|your|a|an) .*\b(worktree|repository|repo|changes|diff)\b.*$/i,
  /^please (provide|give|tell)( me)? (the|a|your) .*\b(path|location|worktree|repository|repo|directory)\b.*$/i,
  /^could you (provide|give|tell)( me)? (the|a|your) .*\b(path|location|worktree|repository|repo|description)\b.*$/i,
  /^i (can'?t|cannot|couldn'?t|could not) (find|locate|access|identify|reach) (a|any|the|my) .*$/i,
  /^(now )?i (have|think i have) enough (context|detail)/i,
  /^have enough (context|detail)/i,
  /^writing (the )?pr description now/i,
  /^let me (examine|inspect|get|find)\b/i,
];

/**
 * The object phrase left behind when a narration sentence is stripped
 * ("…examine THE CHANGES", "…find THE ACTUAL WORKTREE"). Only ever reached on
 * a line a chatter prefix already matched, so a first line that IS content
 * ("The changes are minimal.") never enters here.
 */
const CHATTER_TAIL = /^the (actual worktree|worktree|changes|diff|repository|repo|branch|project|code|files|pr|pull request)\b/i;

/**
 * What a real description can start with — the marker that proves the text
 * after a stripped tail is the body, not more narration. A tail followed by
 * plain prose ("The changes are minimal.") is kept: it cannot be told apart
 * from content, and cutting it would be a silent edit of what the agent wrote.
 */
const REAL_CONTENT_START = /^(#{1,6}|[-*+]\s|\d{1,3}[.)]\s|>\s?|(`{3,}|~{3,}))/;

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
 * Repeatedly cut chatter off the START of one line. Returns '' when the line
 * is entirely chatter (a whole-line `CHATTER` match, or every prefix stripped
 * to nothing), else the line with any leading chatter removed — the remainder
 * of "…changes.## Summary" is a real heading, and losing it would be a silent
 * edit of content the agent actually wrote.
 */
function stripChatterPrefix(line: string): string {
  let current = line.trim();
  for (let pass = 0; pass < 12; pass++) {
    if (isChatter(current)) return '';
    const re = CHATTER_PREFIX.find((candidate) => candidate.test(current));
    if (!re) return current;
    current = current.replace(re, '').replace(/^[\s.,;:!?—–-]+/u, '');
    // The stripped sentence's object phrase ("the changes", "the actual
    // worktree") may still lead the line. Drop it too — but ONLY when the rest
    // of the line is gone or a real content marker (the "…changes.## Summary"
    // glue case). A tail followed by prose stays: it is indistinguishable from
    // a genuine first sentence.
    if (CHATTER_TAIL.test(current)) {
      const rest = current.replace(CHATTER_TAIL, '').replace(/^[\s.,;:!?—–-]+/u, '');
      if (rest === '' || REAL_CONTENT_START.test(rest)) {
        current = rest;
        continue;
      }
    }
  }
  return current;
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
  while (start < end) {
    const line = lines[start]!;
    if (line.trim() === '' || isChatter(line)) {
      start++;
      continue;
    }
    const stripped = stripChatterPrefix(line);
    if (stripped === '') {
      start++;
      continue;
    }
    if (stripped !== line) lines[start] = stripped;
    break;
  }
  while (end > start) {
    const line = lines[end - 1]!;
    if (line.trim() === '' || isChatter(line)) {
      end--;
      continue;
    }
    const stripped = stripChatterPrefix(line);
    if (stripped === '') {
      end--;
      continue;
    }
    if (stripped !== line) lines[end - 1] = stripped;
    break;
  }
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
  /** The unified diff of the branch's changes vs its base, bounded. */
  diff?: string;
  /** True when `diff` was truncated to the cap. */
  diffTruncated?: boolean;
}

/** Everything the local PR-description renderer needs. */
export interface PrDescriptionContext extends PrDiffContext {
  /** The final PR title. */
  title: string;
  /** Repository metadata retained for callers/templates and future formatting. */
  repo?: string;
  branch?: string;
  baseRef?: string;
  /**
   * A gate stage's latest run answered a different question set than the one
   * before it (RC5). Rendered as a note so a gate deleted from the manifest —
   * rather than fixed — cannot read as a pass in the public record.
   */
  gateSetChanged?: boolean;
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
  if (!ctx.commits && !ctx.diffStat && !ctx.gateSetChanged) return ctx.title;

  const parts = ['## Summary', '', ctx.title];
  if (ctx.gateSetChanged) {
    parts.push(
      '',
      '## Note',
      '',
      'The gate set changed since the previous attempt of a gate stage — this branch is not ' +
        'answering the same questions the last attempt answered, and a gate may have been ' +
        'removed rather than fixed.',
    );
  }
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
