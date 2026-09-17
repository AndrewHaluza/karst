/**
 * Pure string functions for composing entry-point seeds. No vscode, fs, or
 * store imports — these are unit-testable under vitest with no host wiring.
 */

import type { EntryBasename } from './workflowCommand.js';

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

/**
 * Compose the resume seed: an invocation-first string when a materialized
 * command exists, or the inline-marker shape when no command was materialized.
 * The `markerInstruction` is appended on both branches so the done-marker is
 * always inline in every seed (§ prompt-effectiveness metrics).
 *
 * `serversInstruction` (the `## Services` block from
 * `cli/serversCommand.ts`'s `renderServersInstruction`) sits between the brief
 * and the marker on both branches: a resumed session starts this ticket's
 * services exactly as a fresh one does, and a service started by hand registers
 * no `servers` row, so the dashboard shows nothing while the session truthfully
 * reports it started one. Absent when the ticket scopes no runnable repository.
 */
export function composeResumeSeed(input: {
  ticketKey: string;
  resumeBrief: string;
  invocation?: string;
  markerInstruction?: string;
  serversInstruction?: string;
}): string {
  const { ticketKey, resumeBrief, invocation, markerInstruction, serversInstruction } = input;
  const servers = serversInstruction?.trim();
  const tail = `${servers ? `\n\n${servers}` : ''}${markerInstruction ? `\n\n${markerInstruction}` : ''}`;
  if (invocation) {
    return `${invocation} ${ticketKey}\n\n${resumeBrief}${tail}`.trim();
  }
  return `${resumeBrief}${tail}`;
}

/**
 * Compose the conflict-override seed: prepend the resolve-conflict invocation
 * line and a blank line to the brief when a materialized command exists, or
 * return the brief unchanged when no command was materialized. The
 * `markerInstruction` is appended on both branches so the done-marker is
 * always inline in every seed (§ prompt-effectiveness metrics).
 */
export function composeConflictSeed(input: {
  ticketKey: string;
  conflictBrief: string;
  invocation?: string;
  markerInstruction?: string;
}): string {
  const { ticketKey, conflictBrief, invocation, markerInstruction } = input;
  const markerSuffix = markerInstruction ? `\n\n${markerInstruction}` : '';
  if (invocation) {
    return `${invocation} ${ticketKey}\n\n${conflictBrief}${markerSuffix}`.trim();
  }
  return `${conflictBrief}${markerSuffix}`;
}
