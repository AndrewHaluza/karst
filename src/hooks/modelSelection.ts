import type { Store } from '../store/db.js';
import { getTicket } from '../store/tickets.js';
import { postMessage } from '../store/ticketMessages.js';
import type { HookPayload } from './dispatch.js';

type SelectedModel = NonNullable<HookPayload['model']>;

/**
 * The model recorded for the ticket's running agent turn, or `null` when no
 * running `session`/`fix` process run carries one. This is the configured
 * launch model — the identity the ticket asked for, not the agent's guess.
 */
export function runningSessionModel(store: Store, ticketId: number): string | null {
  const row = store.db
    .prepare(
      `SELECT model FROM process_runs
        WHERE ticket_id = ? AND status = 'running'
          AND process_id IN ('session','fix')
          AND model IS NOT NULL
        ORDER BY started_at DESC, id DESC
        LIMIT 1`,
    )
    .get(ticketId) as { model: string } | undefined;
  return row?.model ?? null;
}

/**
 * T1005: the first model step of an opencode2 session reported a model that
 * differs from the configured one. Record a durable host event on the ticket
 * naming BOTH models. Observation only — the session is never stopped here.
 *
 * Returns true when a warning was recorded. Malformed/absent comparison data
 * (no running run, no model recorded) is not a mismatch, so nothing is written.
 */
export function recordModelSelectionWarning(
  store: Store,
  ticketId: number,
  observed: SelectedModel,
  debug?: (message: string) => void,
): boolean {
  try {
    const configured = runningSessionModel(store, ticketId);
    if (configured === null) return false;
    const expected = configured.split('#')[0] ?? configured;
    const actual = `${observed.providerID}/${observed.modelID}`;
    if (expected === actual) return false;
    postMessage(store, {
      projectId: getTicket(store, ticketId).projectId,
      fromTicketId: null,
      toTicketId: ticketId,
      kind: 'event',
      body:
        `Warning: opencode2 ran the first turn on ${actual}, but the configured model is ` +
        `${expected}. The session was not stopped.`,
    });
    return true;
  } catch (error) {
    debug?.(`[model-selected] ticket ${ticketId}: warning not recorded: ${String(error)}`);
    return false;
  }
}
