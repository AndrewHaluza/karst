/**
 * The canonical-intent pass (§ ticket analysis). Writes a BLACK-BOX test
 * charter — what a user can observe when the ticket is done — for the UAT
 * tester. It never sees code, a plan, a diff, or code pointers: a charter
 * derived from the implementation produces tests that confirm the
 * implementation (false positives). Runs in an empty temp dir.
 */
import type { AgentAdapter } from '../../agent/adapter.js';
import type { TicketType } from '../../store/ticketTypes.js';
import { withEmptyCwd } from './sandbox.js';
import { ROLE_BOUNDARY_LINE, UNTRUSTED_INPUT_RULES, MISSING_INFO_RULES } from './promptRules.js';

export interface IntentInput {
  title: string;
  ticketType?: TicketType;
  authorPrompt?: string;
  brief?: string;
  improvedDescription?: string;
  model?: string;
  effort?: string;
  ticketId?: number | null;
  processRunId?: number | null;
}
export interface IntentResult {
  text: string | null;
  degraded: boolean;
}

const INTENT_REFORMAT_NUDGE =
  'Your previous answer did not follow the format. Reply again with ONLY the "## Goal" and "## Scenarios" sections (and optional "## Not in scope"), every scenario a "Given …, when …, then …" line.';

export function buildIntentPrompt(input: IntentInput): string {
  const sources = [
    input.authorPrompt?.trim() ? ['Author prompt:', input.authorPrompt.trim(), ''] : [],
    input.brief?.trim() ? ['Fetched brief:', input.brief.trim(), ''] : [],
    input.improvedDescription?.trim()
      ? ['Improved description:', input.improvedDescription.trim(), '']
      : [],
  ].flat();
  return [
    `Write the black-box test charter for ONE ticket: what a user can OBSERVE once it is done. ${ROLE_BOUNDARY_LINE}`,
    ...UNTRUSTED_INPUT_RULES,
    ...MISSING_INFO_RULES,
    'Only observable behavior: UI, CLI output, API responses, stored state a user can see. No file paths, modules, functions, tables, repos, or implementation steps.',
    'Every scenario must be checkable by someone who never reads the code.',
    '',
    `Title: ${input.title.trim() || '(untitled)'}`,
    ...(input.ticketType ? [`Type: ${input.ticketType}`] : []),
    '',
    ...sources,
    'Output EXACTLY this markdown and nothing else:',
    '## Goal',
    '<one paragraph: the user-visible outcome>',
    '',
    '## Scenarios',
    '- Given <state>, when <action>, then <observable outcome>',
    '',
    '## Not in scope',
    '- <optional; omit the section when the ticket names nothing>',
  ].join('\n');
}

export function parseIntent(raw: string): string | null {
  // Anchor on a real "## Goal" heading line, drop leading prose and a trailing code fence.
  const start = raw.search(/^## Goal[ \t]*$/m);
  if (start === -1) return null;
  const text = raw.slice(start).replace(/\n?```\s*$/, '').trim();
  const sections = new Map<string, string>();
  for (const part of text.split(/^## /m).slice(1)) {
    const nl = part.indexOf('\n');
    const name = (nl === -1 ? part : part.slice(0, nl)).trim();
    sections.set(name, nl === -1 ? '' : part.slice(nl + 1).trim());
  }
  if ((sections.get('Goal') ?? '') === '') return null;
  const lines = (sections.get('Scenarios') ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('- '));
  if (lines.length === 0 || !lines.every((l) => /\bthen\b/i.test(l))) return null;
  return text;
}

export async function generateIntent(
  adapter: AgentAdapter,
  input: IntentInput,
  debug?: (msg: string) => void,
): Promise<IntentResult> {
  const hasSource = [input.authorPrompt, input.brief, input.improvedDescription, input.title].some(
    (s) => s?.trim(),
  );
  if (!hasSource) return { text: null, degraded: false };
  const prompt = buildIntentPrompt(input);
  const call = (p: string, cwd: string) =>
    adapter.runHeadless({
      prompt: p,
      cwd,
      ...(input.model !== undefined ? { model: input.model } : {}),
      ...(input.effort !== undefined ? { effort: input.effort } : {}),
      tracking: {
        callSite: 'ticket-intent',
        ticketId: input.ticketId ?? null,
        processRunId: input.processRunId ?? null,
      },
    });
  try {
    const text = await withEmptyCwd(
      async (cwd) =>
        parseIntent((await call(prompt, cwd)).raw) ??
        parseIntent((await call(`${prompt}\n\n${INTENT_REFORMAT_NUDGE}`, cwd)).raw),
    );
    return { text, degraded: text === null };
  } catch (e) {
    debug?.(`[agent:intent] adapter failed: ${e instanceof Error ? e.message : 'unknown'}`);
    return { text: null, degraded: true };
  }
}
