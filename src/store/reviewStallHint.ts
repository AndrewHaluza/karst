import type { Store } from './db.js';
import { listFindings, recordFindings } from './reviewFindings.js';

/** Title of the human finding that carries a "Redesign hint…" note. */
export const REDESIGN_HINT_TITLE = 'Redesign hint';

/**
 * Record the user's redesign hint as a human `info` finding (no schema change).
 * It never counts toward a stall (stall input is agent findings only) and the
 * fix brief reads it back with `reviewStallHint`.
 */
export function recordReviewStallHint(
  store: Store,
  ticketId: number,
  attempt: number,
  runAt: string,
  hint: string,
): void {
  recordFindings(store, {
    ticketId,
    attempt,
    runAt,
    findings: [{ severity: 'info', repo: '', title: REDESIGN_HINT_TITLE, detail: hint, source: 'human' }],
  });
}

/** The newest redesign hint for the ticket, or null. */
export function reviewStallHint(store: Store, ticketId: number): string | null {
  const hints = listFindings(store, ticketId).filter(
    (f) => f.source === 'human' && f.title === REDESIGN_HINT_TITLE,
  );
  const last = hints.reduce<(typeof hints)[number] | null>(
    (max, f) => (max === null || f.runAt >= max.runAt ? f : max),
    null,
  );
  return last?.detail ?? null;
}
