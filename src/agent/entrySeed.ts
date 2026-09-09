/**
 * Pure string functions for composing entry-point seeds. No vscode, fs, or
 * store imports — these are unit-testable under vitest with no host wiring.
 */

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
 * command exists (omitting the marker — the command carries it), or the
 * inline-marker shape when no command was materialized.
 */
export function composeResumeSeed(input: {
  ticketKey: string;
  resumeBrief: string;
  invocation?: string;
  markerInstruction?: string;
}): string {
  const { ticketKey, resumeBrief, invocation, markerInstruction } = input;
  if (invocation) {
    const markerSuffix = markerInstruction ? `\n\n${markerInstruction}` : '';
    return `${invocation} ${ticketKey}\n\n${resumeBrief}${markerSuffix}`.trim();
  }
  return `${resumeBrief}${markerInstruction ? `\n\n${markerInstruction}` : ''}`;
}

/**
 * Compose the conflict-override seed: prepend the resolve-conflict invocation
 * line and a blank line to the brief when a materialized command exists, or
 * return the brief unchanged when no command was materialized.
 */
export function composeConflictSeed(input: {
  ticketKey: string;
  conflictBrief: string;
  invocation?: string;
  markerInstruction?: string;
}): string {
  const { ticketKey, conflictBrief, invocation } = input;
  if (invocation) {
    return `${invocation} ${ticketKey}\n\n${conflictBrief}`.trim();
  }
  return conflictBrief;
}
