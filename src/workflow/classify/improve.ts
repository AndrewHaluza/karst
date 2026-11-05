/**
 * The improve half of the two-pass Improve-with-AI (§ ticket form). Consumes
 * the Settings profile body as its prompt (or a built-in fallback) and runs in
 * the project root so the profile's reference lookups (.karst/karst.yml,
 * CLAUDE.md, docs/glossary.md) resolve. The classifier-selected repository is
 * named in the prompt as data, NOT set as the working directory.
 */

import type { AgentAdapter } from '../../agent/adapter.js';
import type { TicketType } from '../../store/ticketTypes.js';
import { ROLE_BOUNDARY_LINE, UNTRUSTED_INPUT_RULES, MISSING_INFO_RULES } from './promptRules.js';
import { isAlreadyShaped, isStructuredSpec } from './specShape.js';

const FEATURE_SHAPE: readonly string[] = [
  "<one sentence: the change, in the project's own words>",
  '',
  '**Why:** <only when the ticket states a reason: the concrete failure or gap>',
  '',
  '**Done when:** <only outcomes the ticket states, 0-4, each an observable state or behavior>',
  '',
  '**Not in scope:** <optional: what the ticket explicitly excludes>',
];

const BUG_SHAPE: readonly string[] = [
  "<one sentence: what is broken, in the project's own words>",
  '',
  '**Actual:** <what happens now>',
  '**Expected:** <only when the ticket states it: what should happen>',
  '**Repro:** <steps, verbatim when given; "unknown" when not>',
];

const PRESERVE_VERBATIM_RULE =
  '- Preserve verbatim: error strings, ids, ticket keys, versions, URLs, quoted user reports, reproduction steps, example values, planning/decision references.';
const BOILERPLATE_RULE =
  '- No boilerplate: "this ticket aims to", "as a user I want", "Background", "Overview", tracker/status/date chatter.';

export interface BuiltInImproveOptions {
  /** The description is already a structured spec (see `isStructuredSpec`): keep its form. */
  spec?: boolean;
  /** The description already carries its type's shape labels (see `isAlreadyShaped`): keep it as is. */
  shaped?: boolean;
}

/** An already-shaped description comes back nearly unchanged. */
function buildShapedImprovePrompt(): string {
  return [
    'Tidy ONE ticket description that is already in shape. ' + ROLE_BOUNDARY_LINE,
    ...UNTRUSTED_INPUT_RULES,
    '',
    'Return it as written. Do not reword, reorder, merge or add sentences, reasons or claims. Only bold its section labels (e.g. **Why:**), fix typos, and remove tracker chatter.',
    '',
    'Rules:',
    PRESERVE_VERBATIM_RULE,
  ].join('\n');
}

/** A structured spec keeps its structure; only noise is removed. No type shape, no word cap. */
function buildSpecImprovePrompt(): string {
  return [
    'Clean up ONE ticket description that is already a structured spec. ' + ROLE_BOUNDARY_LINE,
    ...UNTRUSTED_INPUT_RULES,
    '',
    'Keep its structure and every requirement, decision, id and test name. Remove only tracker chatter, template headings with nothing under them, and duplicated text. Do not reshape it into sections or shorten it to a word limit.',
    '',
    'Rules:',
    '- Do not restate the title. Paths and names already in the spec stay; do not add new ones or cite files you consulted.',
    BOILERPLATE_RULE,
    "- Keep the author's intent and scope EXACTLY.",
    PRESERVE_VERBATIM_RULE,
    ...MISSING_INFO_RULES.map((r) => `- ${r}`),
  ].join('\n');
}

/**
 * Built-in description-rewriter prompt used when no profile body is configured.
 * A structured spec keeps its form; otherwise a bug (`fix`) gets the
 * Actual/Expected/Repro shape and everything else gets Why / Done when.
 * A profile body REPLACES this prompt entirely (user ruling).
 */
export function buildBuiltInImprovePrompt(ticketType?: TicketType, opts: BuiltInImproveOptions = {}): string {
  if (opts.spec) return buildSpecImprovePrompt();
  if (opts.shaped) return buildShapedImprovePrompt();
  const shape = ticketType === 'fix' ? BUG_SHAPE : FEATURE_SHAPE;
  return [
    'Improve ONE ticket description into a short, precise statement of WHAT to achieve and WHY. ' +
      ROLE_BOUNDARY_LINE,
    ...UNTRUSTED_INPUT_RULES,
    '',
    'Shape (drop any section with nothing real in it):',
    ...shape,
    '',
    'Rules:',
    '- Say WHAT and WHY, not HOW. No phases, step ordering, or research/plan/approve gates.',
    '- Do not restate the title. Do not name repos, services, file paths, modules or functions.',
    BOILERPLATE_RULE,
    "- Keep the author's intent and scope EXACTLY. An already-tight description comes back nearly unchanged.",
    `${PRESERVE_VERBATIM_RULE} Verbatim content does not count toward the word limit.`,
    ...MISSING_INFO_RULES.map((r) => `- ${r}`),
    '- Name unknowns in one short line at the end, never as a section.',
    '- Under 120 words, excluding verbatim content.',
  ].join('\n');
}

/** Kept for existing imports: the feature-shaped built-in prompt. */
export const BUILT_IN_IMPROVE_PROMPT = buildBuiltInImprovePrompt();

export interface ImproveInput {
  /** The resolved Settings profile body; may be blank. */
  instructions: string;
  /** The text to improve (author prompt + fetched brief). */
  description: string;
  /** Ticket title; may be empty. */
  title: string;
  /** Effective ticket type (user pick ?? classify type); selects the built-in shape. */
  ticketType?: TicketType;
  /** The PROJECT ROOT to run in (dirname(dirname(manifestPath))). */
  cwd: string;
  /** The classifier-selected repository's absolute path, rendered as a `Primary repository:` line. Absent → the line is omitted. */
  repoPath?: string;
  /** The profile's `context: minimal` (only meaningful with `instructions`). */
  context?: 'minimal';
  model?: string;
  effort?: string;
  ticketId?: number | null;
  processRunId?: number | null;
}

/**
 * Run a repo-context description rewrite through the Settings profile body (or
 * the built-in improver prompt). Returns the improved prose trimmed of
 * surrounding whitespace.
 */
export async function improveDescription(
  adapter: AgentAdapter,
  input: ImproveInput,
): Promise<string> {
  const source = input.description.trim();
  if (!source) throw new Error('nothing to improve');

  const instruction = input.instructions.trim()
    ? input.instructions.trim()
    : buildBuiltInImprovePrompt(input.ticketType, { spec: isStructuredSpec(source), shaped: isAlreadyShaped(source, input.ticketType) });

  const titleLine = input.title.trim() || '(untitled)';
  const repoLine = input.repoPath
    ? [`Primary repository: ${input.repoPath}`, '']
    : [];

  const prompt = [
    instruction,
    '',
    '## The ticket',
    `Title: ${titleLine}`,
    ...(input.ticketType ? [`Type: ${input.ticketType}`] : []),
    ...repoLine,
    'Current description to improve:',
    source,
    '',
    'Rewrite it per the instructions above. Return the replacement description text only, with no preamble, code fence, or JSON.',
  ].join('\n');

  const result = await adapter.runHeadless({
    prompt,
    cwd: input.cwd,
    ...(input.context === 'minimal' ? { minimalContext: 'skills-and-subagents' as const } : {}),
    ...(input.model !== undefined ? { model: input.model } : {}),
    ...(input.effort !== undefined ? { effort: input.effort } : {}),
    tracking: {
      callSite: 'ticket-improve',
      ticketId: input.ticketId ?? null,
      processRunId: input.processRunId ?? null,
    },
  });

  return result.raw.trim();
}
