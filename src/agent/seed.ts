/**
 * Compose the initial prompt seeded into a fresh interactive session. This is
 * agent-agnostic plain text assembled from up to three parts, in order:
 *   1. the workflow `invocation` (e.g. `/karst:rpi PROJ-9`), when present;
 *   2. the ticket-context markdown (built by `renderTicketContext`, § context
 *      loader) — the ticket's own prompt/brief/repos plus its live
 *      worktrees/branches/services/PRs;
 *   3. the chosen approach's method prompt, when one resolved.
 *
 * The ticket-context SHAPING lives in `src/context/ticketContext.ts` so it can be
 * reused by the `karst context` CLI; this module only composes the sections.
 */

/**
 * Compose the session seed from pre-rendered parts. Returns `undefined` only
 * when there is genuinely nothing to say (no invocation, no context, no method)
 * — the caller then launches bare.
 */
export function buildSessionSeed(
  contextMarkdown: string | null | undefined,
  approachPrompt: string | null | undefined,
  invocation?: string | null,
  markerInstruction?: string | null,
): string | undefined {
  const method = approachPrompt?.trim();
  const context = contextMarkdown?.trim();
  const inv = invocation?.trim();
  // The impl→uat marker (§5.4) is a WORKFLOW invariant, not an approach detail:
  // every launch (direct/approach/solo) must tell the agent to fire it, so a
  // `direct` ticket that never materializes a workflow command still leaves impl.
  const marker = markerInstruction?.trim();

  const sections: string[] = [];
  if (inv) sections.push(inv);
  if (context) sections.push(context);
  if (method) sections.push(`# Approach\n\n${method}`);
  if (marker) sections.push(marker);
  if (sections.length === 0) return undefined;
  return sections.join('\n\n');
}
