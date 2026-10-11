/**
 * Opt-in code-pointer pass: names where in the code a ticket probably lands,
 * as UNVERIFIED hints for the implementer only. Kept out of the description
 * (and out of intent) on purpose: the description feeds the tester, and a
 * wrong guess stated in it would read as fact.
 */
import type { AgentAdapter } from '../../agent/adapter.js';
import { UNTRUSTED_INPUT_RULES } from './promptRules.js';

const POINTER_LINE = /^- \S+?(?::\d+)? — .+$/;
const MAX_POINTERS = 8;

export interface CodePointersInput {
  title: string;
  description: string;
  repoPath: string;
  model?: string;
  effort?: string;
  ticketId?: number | null;
  processRunId?: number | null;
}
/** `degraded` is true ONLY when the adapter threw; "found nothing" is a valid answer. */
export interface CodePointersResult {
  text: string | null;
  degraded: boolean;
}

export function parseCodePointers(raw: string): string | null {
  const lines = raw
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => POINTER_LINE.test(l))
    .slice(0, MAX_POINTERS);
  return lines.length ? lines.join('\n') : null;
}

export async function generateCodePointers(
  adapter: AgentAdapter,
  input: CodePointersInput,
  debug?: (msg: string) => void,
): Promise<CodePointersResult> {
  const prompt = [
    'Find where in THIS repository the ticket below most likely lands. Read code as needed; change nothing.',
    ...UNTRUSTED_INPUT_RULES,
    `Output at most ${MAX_POINTERS} lines, each exactly: "- <relative/path>[:<line>] — <why, under 12 words>". No other text. Nothing plausible → output nothing.`,
    '',
    `Title: ${input.title.trim() || '(untitled)'}`,
    '',
    'Description:',
    input.description.trim(),
  ].join('\n');
  try {
    const r = await adapter.runHeadless({
      prompt,
      cwd: input.repoPath,
      ...(input.model !== undefined ? { model: input.model } : {}),
      ...(input.effort !== undefined ? { effort: input.effort } : {}),
      tracking: {
        callSite: 'ticket-code-pointers',
        ticketId: input.ticketId ?? null,
        processRunId: input.processRunId ?? null,
      },
    });
    return { text: parseCodePointers(r.raw), degraded: false };
  } catch (e) {
    debug?.(`[agent:code-pointers] adapter failed: ${e instanceof Error ? e.message : 'unknown'}`);
    return { text: null, degraded: true };
  }
}
