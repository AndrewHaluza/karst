/**
 * The DBG-03 evidence vocabulary, shared by the log buffer's retention
 * (`logging/logger.ts`) and the report's log selection
 * (`diagnostics/collectMetadata.ts`).
 *
 * A leaf module: it imports nothing, so both sides can depend on it without
 * pulling the reporting boundary into the buffer or vice versa. It is the one
 * definition of "a line a report exists to carry" — a change here changes what
 * the buffer protects AND what the report ranks, which is exactly why it is
 * shared rather than duplicated.
 */

/**
 * Prefixes that mark a line as ticket evidence. `[driver]` is deliberately
 * absent: the driver is chatty and its lines qualify only when they name the
 * report's ticket (a report-time decision the buffer cannot make — it is not
 * ticket-scoped).
 */
export const EVIDENCE_PREFIXES = [
  '[runtime]',
  '[gate]',
  '[stage]',
  '[stage-log]',
  '[merge]',
  '[hot]',
  '[hotSet]',
  '[staged]',
] as const

/** True when a message starts with one of the DBG-03 evidence prefixes. */
export function isEvidenceMessage(message: string): boolean {
  return EVIDENCE_PREFIXES.some((prefix) => message.startsWith(prefix))
}

/** `/\bT<id>\b|\bticket <id>\b/` for the report's ticket; none for a project report. */
export function ticketPatternFor(ticketId: number | null): RegExp | null {
  if (ticketId === null) return null
  return new RegExp(`\\bT${ticketId}\\b|\\bticket ${ticketId}\\b`)
}
