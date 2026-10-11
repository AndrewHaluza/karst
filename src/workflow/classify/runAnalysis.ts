import type { AgentAdapter } from '../../agent/adapter.js';
import type { TicketType } from '../../store/ticketTypes.js';
import { analyzeTicket, type AnalyzeInput, type TicketAnalysis } from './analyze.js';
import { improveDescription } from './improve.js';
import { generateIntent } from './intent.js';
import { generateCodePointers } from './codePointers.js';

export type AnalysisPass = 'classify' | 'improve' | 'intent' | 'code-pointers';

export interface RunAnalysisInput {
  /** Classify inputs (brief, prompt, services, approaches, ids, model, effort). */
  analyze: AnalyzeInput;
  title: string;
  /** Caller-bound type (a saved ticket's type). Undefined (fresh ticket) → the classify result's `type`. */
  ticketType?: TicketType;
  /**
   * `resolveRepoPath` is called ONCE, after classify, with `classification.repos`; its result is
   * improve's `repoPath` AND the code-pointer pass's cwd. undefined = no repo resolvable
   * (improve runs without a repoPath line; the pointer pass is skipped silently).
   */
  improve: { instructions: string; cwd: string; resolveRepoPath: (repos: string[]) => string | undefined };
  codePointers: { enabled: boolean };
  warn?: (msg: string) => void;
}

export interface RunAnalysisResult {
  classification: TicketAnalysis;
  /** improved || classification.prompt */
  description: string;
  intent: string | null;
  codePointers: string | null;
  /** Passes that fell back. */
  degraded: AnalysisPass[];
}

/** Sequential; classify errors propagate, every later pass soft-fails. */
export async function runAnalysis(adapter: AgentAdapter, input: RunAnalysisInput): Promise<RunAnalysisResult> {
  const { analyze, title, ticketType, improve, warn } = input;
  const ids = { ticketId: analyze.ticketId ?? null, processRunId: analyze.processRunId ?? null };
  const tuning = {
    ...(analyze.model !== undefined ? { model: analyze.model } : {}),
    ...(analyze.effort !== undefined ? { effort: analyze.effort } : {}),
  };

  const classification = await analyzeTicket(adapter, analyze);
  const degraded: AnalysisPass[] = classification.degraded ? ['classify'] : [];
  const effectiveType = ticketType ?? classification.type;

  const repoPath = improve.resolveRepoPath(classification.repos);
  const combined = [analyze.prompt, analyze.brief].filter(Boolean).join('\n\n');
  let improved = '';
  try {
    improved = await improveDescription(adapter, {
      instructions: improve.instructions,
      description: combined,
      title,
      ...(effectiveType ? { ticketType: effectiveType } : {}),
      cwd: improve.cwd,
      ...(repoPath ? { repoPath } : {}),
      ...ids,
      ...tuning,
    });
  } catch (error) {
    warn?.(`description improve failed: ${error instanceof Error ? error.message : String(error)}`);
    degraded.push('improve');
  }
  const description = improved.trim() || classification.prompt;

  const intent = await generateIntent(adapter, {
    title,
    ...(effectiveType ? { ticketType: effectiveType } : {}),
    ...(analyze.prompt !== undefined ? { authorPrompt: analyze.prompt } : {}),
    brief: analyze.brief,
    improvedDescription: description,
    ...ids,
    ...tuning,
  });
  if (intent.degraded) degraded.push('intent');

  // Runs LAST so pointers can never feed intent.
  let codePointers: string | null = null;
  if (input.codePointers.enabled && repoPath) {
    const pointers = await generateCodePointers(adapter, { title, description, repoPath, ...ids, ...tuning });
    codePointers = pointers.text;
    if (pointers.degraded) degraded.push('code-pointers');
  }

  return { classification, description, intent: intent.text, codePointers, degraded };
}
