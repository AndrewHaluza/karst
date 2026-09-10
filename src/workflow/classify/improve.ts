/**
 * The improve half of the two-pass Improve-with-AI (§ ticket form). Consumes
 * the Settings profile body as its prompt (or a built-in fallback) and runs in
 * the project root so the profile's reference lookups (.karst/karst.yml,
 * CLAUDE.md, docs/glossary.md) resolve. The classifier-selected repository is
 * named in the prompt as data, NOT set as the working directory.
 */

import type { AgentAdapter } from '../../agent/adapter.js';

/** Built-in description-rewriter prompt used when no profile body is configured. */
export const BUILT_IN_IMPROVE_PROMPT =
  'Improve ONE ticket description into a short, precise statement of WHAT to achieve and WHY. ' +
  'Say WHAT and WHY, not HOW. Do not restate the title. Do not name repos, services, or file paths. ' +
  "Keep the author's intent and scope EXACTLY. Preserve verbatim: error strings, ids, keys, versions, URLs. " +
  'If the description is already tight, return it nearly unchanged. Under 120 words.';

export interface ImproveInput {
  /** The resolved Settings profile body; may be blank. */
  instructions: string;
  /** The text to improve (author prompt + fetched brief). */
  description: string;
  /** Ticket title; may be empty. */
  title: string;
  /** The PROJECT ROOT to run in (dirname(dirname(manifestPath))). */
  cwd: string;
  /** The classifier-selected repository's absolute path, rendered as a `Primary repository:` line. Absent → the line is omitted. */
  repoPath?: string;
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
    : BUILT_IN_IMPROVE_PROMPT;

  const titleLine = input.title.trim() || '(untitled)';
  const repoLine = input.repoPath
    ? [`Primary repository: ${input.repoPath}`, '']
    : [];

  const prompt = [
    instruction,
    '',
    '## The ticket',
    `Title: ${titleLine}`,
    ...repoLine,
    'Current description to improve:',
    source,
    '',
    'Rewrite it per the instructions above. Return the replacement description text only, with no preamble, code fence, or JSON.',
  ].join('\n');

  const result = await adapter.runHeadless({
    prompt,
    cwd: input.cwd,
    ...(input.model !== undefined ? { model: input.model } : {}),
    ...(input.effort !== undefined ? { effort: input.effort } : {}),
    tracking: {
      callSite: 'ticket-analysis',
      ticketId: input.ticketId ?? null,
      processRunId: input.processRunId ?? null,
    },
  });

  return result.raw.trim();
}
