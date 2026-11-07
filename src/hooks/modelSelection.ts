import type { Store } from '../store/db.js';
import { getTicket } from '../store/tickets.js';
import { postMessage } from '../store/ticketMessages.js';
import { getSessionLaunchIntent } from '../store/sessionLaunchIntents.js';
import type { HookPayload } from './dispatch.js';

type SelectedModel = NonNullable<HookPayload['model']>;

/**
 * The model a ticket's session launch was CONFIGURED to use.
 *
 * The launch intent — not `process_runs.model` — is the record of what a launch
 * asked for: every interactive launch writes one, including a deliberate switch
 * and a resume. `process_runs.model` is written once when the run opens and is
 * never updated, so after a live model switch it still names the previous
 * model and the guard would warn about the model the user just chose (review of
 * T1005). The endpoint rebuilds `launchId` from host facts, so it pins the
 * exact launch that reported — never a newer `fix` run that happens to be
 * running. When it is absent (a legacy channel) the newest intent for the
 * ticket is the best available answer.
 */
export function configuredSessionModel(
  store: Store,
  ticketId: number,
  launchId?: string,
): string | null {
  if (launchId !== undefined) {
    const intent = getSessionLaunchIntent(store, launchId);
    if (intent !== undefined) return intent.model;
  }
  const row = store.db
    .prepare(
      `SELECT model FROM session_launch_intents
        WHERE ticket_id = ? AND model IS NOT NULL
          AND status IN ('pending','confirmed')
        ORDER BY created_at DESC, id DESC
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
 * (no launch intent with a model) is not a mismatch, so nothing is written.
 */
export function recordModelSelectionWarning(
  store: Store,
  ticketId: number,
  observed: SelectedModel,
  launchId?: string,
  debug?: (message: string) => void,
): boolean {
  try {
    const configured = configuredSessionModel(store, ticketId, launchId);
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
