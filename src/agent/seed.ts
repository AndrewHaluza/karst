/**
 * Compose the initial prompt seeded into a fresh interactive session. This is
 * agent-agnostic plain text assembled from up to three parts, in order:
 *   1. the workflow `invocation` (e.g. `/karst:rpi PROJ-9`), when present;
 *   2. the ticket-context markdown (built by `renderTicketContext`, § context
 *      loader) — the ticket's own prompt/brief/repos plus its live
 *      worktrees/branches/services/PRs;
 *   3. the chosen approach's method prompt, when one resolved;
 *   4. a one-line pointer to the agent manual (`karst guide`), when one is
 *      composed — the manual itself is pulled on demand, never embedded;
 *   5. the done-marker instruction, when the ticket sits at a marker stage.
 *
 * The ticket-context SHAPING lives in `src/context/ticketContext.ts` so it can be
 * reused by the `karst context` CLI; this module only composes the sections.
 */

import { seedCharLength, seedHasGuide } from './promptTelemetry.js';
import { truncateToBudget, SEED_BUDGETS } from './seedBudget.js';

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
  guideInstruction?: string | null,
  ticketKey?: string,
  debug?: (msg: string) => void,
): string | undefined {
  let method = approachPrompt?.trim();
  const context = contextMarkdown?.trim();
  const inv = invocation?.trim();
  // The impl→uat marker (§5.4) is a WORKFLOW invariant, not an approach detail:
  // every launch (direct/approach/solo) must tell the agent to fire it, so a
  // `direct` ticket that never materializes a workflow command still leaves impl.
  const marker = markerInstruction?.trim();
  // One cheap pointer to the agent manual (how Karst works, the flow, the CLI
  // verbs) — the full guide is pulled on demand via `karst guide`, never
  // embedded here (869edmcme). Placed before the marker so reading order is
  // execution order: learn the tooling first, close the stage last.
  const guide = guideInstruction?.trim();

  if (method) {
    const key = ticketKey ?? 'this ticket';
    const { text, truncated } = truncateToBudget(method, SEED_BUDGETS.approachMethod, key);
    if (truncated) debug?.(`[seed] truncated approach method to ${SEED_BUDGETS.approachMethod} chars`);
    method = text;
  }

  const sections: string[] = [];
  if (inv) sections.push(inv);
  if (context) sections.push(context);
  if (method) sections.push(`# Approach\n\n${method}`);
  if (guide) sections.push(guide);
  if (marker) sections.push(marker);
  if (sections.length === 0) return undefined;
  return sections.join('\n\n');
}

/** The seed seam's own effectiveness telemetry: composed length + guide-pointer presence. */
export interface SeedTelemetry {
  seedChars: number;
  guidePointer: boolean;
}

/**
 * Measure a composed seed at the seam that produced it. `buildSessionSeed` hands
 * back a plain string; this reads back the two prompt-effectiveness facts the
 * launch records onto its `process_runs` row (docs/arch/prompt-metrics.md): how
 * many characters of resident context the agent opened with, and whether the
 * guide pointer was among them. It changes nothing about the seed.
 */
export function measureSeed(seed: string | undefined, guideMarker?: string): SeedTelemetry {
  return {
    seedChars: seedCharLength(seed),
    guidePointer: seedHasGuide(seed, guideMarker),
  };
}
