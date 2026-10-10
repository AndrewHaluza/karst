/**
 * The built-in prompt behind each role, shown read-only on the Agents page's
 * "Built-in prompts" list. Rendered by the REAL builders (not copied text), with
 * placeholder targets, so what the user reads is what a run starts from when no
 * agent profile is assigned. Only the prompt-bearing roles have one: the other
 * roles keep a fixed prompt and an agent profile changes their identity only.
 */
import { buildTesterPrompt } from '../../workflow/uat/tester.js';
import { buildFindingsPrompt } from '../../workflow/review/findingsLane.js';
import { BUILT_IN_IMPROVE_PROMPT } from '../../workflow/classify/improve.js';
import { PROCESS_KEYS, type ProcessKey } from '../../manifest/validate/processAssignments.js';

export type BuiltInPrompts = Readonly<Record<ProcessKey, string | null>>;

export function buildBuiltInPrompts(): BuiltInPrompts {
  const prompts = Object.fromEntries(PROCESS_KEYS.map((key) => [key, null])) as Record<ProcessKey, string | null>;
  prompts.uatTester = buildTesterPrompt({ repo: '<repository>', worktreePath: '<worktree>', baseRef: '<base branch>' });
  prompts.review = buildFindingsPrompt('<repository>', '<base branch>', '<branch>');
  prompts.ticketAnalysis = BUILT_IN_IMPROVE_PROMPT;
  return prompts;
}
