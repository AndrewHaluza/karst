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
 * The stated pointer for the ONE section `karst context` cannot recover: the
 * approach-method body. `karst context` renders `TicketContext` — it has no
 * field for the resolved approach's method text, so pointing an agent at it
 * for "the full state" would be a command that runs cleanly and shows
 * nothing relevant, which is worse than no pointer at all. This is the
 * honest alternative for that one truncation site.
 */
export function approachTruncationPointer(): string {
  return ' ... truncated -- the approach method is longer than fits here; the full ' +
    'text lives in the ticket\'s materialized approach package on disk, not in ' +
    '`karst context` (which only ever carries the ticket, never the approach body).';
}

/**
 * Cut `text` to `maxChars` characters of original content and append the
 * stated pointer when it overflows; returns it unchanged otherwise. The cap
 * bounds the SOURCE text, not the final string (the pointer is additional).
 * `pointerOverride` swaps in a different stated pointer for a section where
 * the default `karst context <key>` claim would be false (see
 * `approachTruncationPointer`) — the default keeps every existing caller's
 * behavior unchanged.
 */
export function truncateToBudget(
  text: string,
  maxChars: number,
  ticketKey: string,
  pointerOverride?: string,
): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  const pointer = pointerOverride ?? truncationPointer(ticketKey);
  return { text: text.slice(0, maxChars) + pointer, truncated: true };
}
