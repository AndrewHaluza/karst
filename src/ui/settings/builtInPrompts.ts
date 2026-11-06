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
import { resolveProcessAssignment } from '../../agent/processAssignment.js';
import { resolveAdapter } from '../../agent/registry.js';
import { structuredOutputFormOf, type StructuredOutputForm } from '../../agent/surfaces.js';
import type { Manifest } from '../../manifest/types.js';
import { PROCESS_KEYS, type ProcessKey, type ProcessRole } from '../../manifest/validate/processAssignments.js';

export type BuiltInPrompts = Readonly<Record<ProcessKey, string | null>>;

/**
 * The prompts are rendered for the core each role is assigned to
 * (`resolveProcessAssignment`), so the output rule shown is the one that run
 * receives: tool for claude, final-document for codex, the prose rule for a
 * core with no native structured output. With no manifest no core is known and
 * the core-agnostic prose form is shown.
 */
function outputFormFor(manifest: Manifest | undefined, role: ProcessRole): StructuredOutputForm | undefined {
  if (manifest === undefined) return undefined;
  const assignment = resolveProcessAssignment(manifest, role);
  return assignment === null ? undefined : structuredOutputFormOf(resolveAdapter(assignment.provider));
}

export function buildBuiltInPrompts(manifest?: Manifest): BuiltInPrompts {
  const prompts = Object.fromEntries(PROCESS_KEYS.map((key) => [key, null])) as Record<ProcessKey, string | null>;
  prompts.uatTester = buildTesterPrompt(
    { repo: '<repository>', worktreePath: '<worktree>', baseRef: '<base branch>' },
    undefined,
    undefined,
    { outputForm: outputFormFor(manifest, 'uat-tester') },
  );
  prompts.review = buildFindingsPrompt(
    '<repository>', '<base branch>', '<branch>',
    undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    outputFormFor(manifest, 'review'),
  );
  prompts.ticketAnalysis = BUILT_IN_IMPROVE_PROMPT;
  return prompts;
}
