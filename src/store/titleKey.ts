/**
 * Ticket key derived from a ticket TITLE (§ manual ticket creation).
 *
 * A manually entered ticket has no board id to key on, so the title is the only
 * identity the user actually typed — deriving from it beats a random
 * `MANUAL-XXXXXXXX` nobody can read on the board. Pure and store-free: the
 * uniqueness pass lives in `generateTicketKey` (tickets.ts), and the ticket form
 * webview mirrors THIS rule in plain JS (it cannot import TS) so the key it
 * previews while you type is the key that gets persisted.
 */

/** Longest derived key. Long enough to stay readable, short enough for a pill. */
export const TITLE_KEY_MAX = 32;

/**
 * `[FIX] on ticket/creation` → `FIX-ON-TICKET-CREATION`. Returns '' when the
 * title carries nothing key-able (emoji-only, punctuation-only, blank) — the
 * caller then falls back to a generated key rather than persisting an empty one.
 * Truncation cuts on a word boundary and never leaves a trailing dash.
 */
export function slugifyTitleKey(title: string): string {
  const words = String(title ?? '')
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .filter((w) => w !== '');
  const out: string[] = [];
  let len = 0;
  for (const word of words) {
    const next = len === 0 ? word.length : len + 1 + word.length;
    if (next > TITLE_KEY_MAX) break;
    out.push(word);
    len = next;
  }
  // A single first word longer than the cap would otherwise yield '' — take a
  // hard slice of it so a one-long-word title still derives something.
  if (out.length === 0) return (words[0] ?? '').slice(0, TITLE_KEY_MAX);
  return out.join('-');
}
