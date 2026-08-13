/**
 * Shared follow-up identity — the semantic fact and the compact text marker.
 *
 * A ticket is a follow-up when `tickets.parent_ticket_id` is set. That fact is
 * relationship metadata, never part of the stored title. Surfaces choose how to
 * represent it: rich/icon-capable surfaces render their own marker (the sidebar
 * row's `↳ <parentKey>` parentref), text-only surfaces (editor tab titles,
 * terminal names) use `followUpTextPrefix` — ONE character of relationship
 * identity. Nothing here ever parses a title for "Follow-up:".
 *
 * vscode-free and pure.
 */

/** The single-character text marker for follow-up identity in text-only surfaces. */
export const FOLLOW_UP_TEXT_MARKER = '↳';

/** Whether a ticket is a follow-up — the domain fact, from `parentTicketId`. */
export function isFollowUp(ticket: { parentTicketId: number | null }): boolean {
  return ticket.parentTicketId !== null;
}

/**
 * Compact text prefix for a text-only surface: `'↳ '` for a follow-up ticket,
 * `''` otherwise. Carries its own trailing space so a template can interpolate
 * it directly before the identity (`'Karst: {followUp}{key} — {title}'`) and a
 * non-follow-up renders without a double space.
 */
export function followUpTextPrefix(ticket: { parentTicketId: number | null }): string {
  return isFollowUp(ticket) ? `${FOLLOW_UP_TEXT_MARKER} ` : '';
}

/** Prefix a rendered ticket label with the one-char follow-up marker. */
export function compactTicketLabel(
  ticket: { parentTicketId: number | null },
  label: string,
): string {
  return `${followUpTextPrefix(ticket)}${label}`;
}
