// Before changing what a seed or context render contains, read
// docs/arch/prompt-metrics.md @arch:RESIDENT and @arch:GUIDEGATE.
/**
 * Pure string functions for composing entry-point seeds. No vscode, fs, or
 * store imports — these are unit-testable under vitest with no host wiring.
 */

import type { EntryBasename } from './workflowCommand.js';
import { composeInstructionsBody, type SessionSeed } from './seed.js';

/**
 * The command line a FRESH launch opens with (§ entry-point commands).
 *
 * Two different fields can supply one: `Materialized.invocation`, the
 * approach ORCHESTRATOR, which an adapter emits only for a workflow-bearing
 * approach; and `Materialized.entryInvocations['start-task']`, the generic
 * entry every adapter materializes for every ticket. The orchestrator wins
 * when it exists — it runs that approach's method, and start-task does not —
 * so a workflow ticket is unaffected by this resolution. A `direct` ticket
 * has no orchestrator and gets start-task, which is the case that used to
 * fall through to a fully inline seed even though its command file had
 * already been written to disk.
 *
 * Returns `null` when neither exists (an adapter with no `materializeApproach`,
 * or a materialization that threw). The caller then seeds the self-contained
 * inline form, which is the documented fallback.
 */
export function launchInvocation(input: {
  orchestratorInvocation?: string | null;
  entryInvocations?: Partial<Record<EntryBasename, string>> | undefined;
}): string | null {
  const orchestrator = input.orchestratorInvocation?.trim();
  if (orchestrator) return orchestrator;
  const startTask = input.entryInvocations?.['start-task']?.trim();
  return startTask ? startTask : null;
}

/**
 * Determine the `sections` mode for `renderTicketContext` based on whether a
 * materialized invocation exists. A materialized invocation switches to
 * narrative mode (omitting operational stage/service details); without one,
 * the full context is included.
 */
export function launchSections(hasInvocation: boolean): 'all' | 'narrative' {
  return hasInvocation ? 'narrative' : 'all';
}

/** Join non-empty sections with a blank line between them. */
function joinSections(sections: readonly (string | null | undefined)[]): string {
  return sections
    .map((s) => s?.trim())
    .filter((s): s is string => Boolean(s))
    .join('\n\n');
}

/**
 * Compose the resume seed. On a resume with a materialized command the
 * instruction layer is REGENERATED (current facts + the servers rule + the
 * done marker) and re-attached through the core's channel, while the kickoff
 * shrinks to the short continue/fix brief under the invocation — the rules are
 * never repeated in the first user message. The guide pointer is deliberately
 * NOT regenerated on a resume: a resumed session is not a new guide invite, and
 * omitting it keeps the guide-pull denominator a fresh-launch measure
 * (`docs/arch/prompt-metrics.md`).
 *
 * Without a materialized command (or on a solo-agent `fallback` core) the seed
 * stays self-contained inline exactly as before: brief, facts, servers rule and
 * marker all ride the kickoff.
 */
export function composeResumeSeed(input: {
  ticketKey: string;
  resumeBrief: string;
  invocation?: string;
  markerInstruction?: string;
  serversInstruction?: string;
  factsContext?: string;
  inlineInstructions?: boolean;
}): SessionSeed {
  const { ticketKey, resumeBrief, invocation, markerInstruction, serversInstruction } = input;
  const brief = resumeBrief.trim();
  const facts = input.factsContext?.trim();
  const servers = serversInstruction?.trim();
  const marker = markerInstruction?.trim();
  const invLine = invocation ? `${invocation} ${ticketKey}`.trim() : null;

  if (invLine && !input.inlineInstructions) {
    return {
      instructions: composeInstructionsBody([facts, servers, marker]),
      kickoff: joinSections([invLine, brief]),
    };
  }
  return {
    instructions: null,
    kickoff: joinSections([invLine, brief, facts, servers, marker]),
  };
}

/**
 * Compose the conflict-override seed. With a materialized command the conflict
 * facts + the done marker are delivered through the instruction layer while the
 * kickoff is just the invocation and the short conflict brief. Conflict
 * resolution runs no services, so no servers rule is attached. Without a
 * command (or on a solo-agent `fallback` core) everything inlines into the
 * kickoff as before.
 */
export function composeConflictSeed(input: {
  ticketKey: string;
  conflictBrief: string;
  invocation?: string;
  markerInstruction?: string;
  factsContext?: string;
  inlineInstructions?: boolean;
}): SessionSeed {
  const { ticketKey, conflictBrief, invocation, markerInstruction } = input;
  const brief = conflictBrief.trim();
  const facts = input.factsContext?.trim();
  const marker = markerInstruction?.trim();
  const invLine = invocation ? `${invocation} ${ticketKey}`.trim() : null;

  if (invLine && !input.inlineInstructions) {
    return {
      instructions: composeInstructionsBody([facts, marker]),
      kickoff: joinSections([invLine, brief]),
    };
  }
  return {
    instructions: null,
    kickoff: joinSections([invLine, brief, facts, marker]),
  };
}
