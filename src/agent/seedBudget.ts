/**
 * Per-section character caps for the composed session seed, derived in
 * docs/superpowers/plans/2026-09-07-seed-budget.md from ticket 05's committed
 * ticket-text baseline (docs/arch/prompt-metrics.md) — the `seedChars` metric
 * itself has zero recorded rows, so these are NOT read off that metric.
 * Re-derive from the same doc before changing any of these numbers.
 */
export const SEED_BUDGETS = {
  ticketPrompt: 4000,
  gateSummary: 1000,
  findings: 2000,
  brief: 3000,
  attachments: 1500,
  approachMethod: 8000,
} as const;

/**
 * The stated truncation pointer (§ "Truncation is always stated, never
 * silent"). A silently shortened seed is worse than a long one — the agent
 * must know to pull the rest via `karst context <key>`.
 */
export function truncationPointer(ticketKey: string): string {
  return ` ... truncated -- run \`karst context ${ticketKey}\` for the full state.`;
}

/**
 * Cut `text` to `maxChars` characters of original content and append the
 * stated pointer when it overflows; returns it unchanged otherwise. The cap
 * bounds the SOURCE text, not the final string (the pointer is additional).
 */
export function truncateToBudget(
  text: string,
  maxChars: number,
  ticketKey: string,
): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  return { text: text.slice(0, maxChars) + truncationPointer(ticketKey), truncated: true };
}
