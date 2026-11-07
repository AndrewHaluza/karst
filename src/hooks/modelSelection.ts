import type { Store } from '../store/db.js';
import { getTicket } from '../store/tickets.js';
import { postMessage } from '../store/ticketMessages.js';
import { getSessionLaunchIntent } from '../store/sessionLaunchIntents.js';
import type { HookPayload } from './dispatch.js';

type SelectedModel = NonNullable<HookPayload['model']>;

/** The configured model plus effort a launch asked for. */
export interface ConfiguredSessionSelection {
  model: string;
  effort: string | null;
}

/**
 * The model and effort a ticket's session launch was CONFIGURED to use.
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
 *
 * `effort` is its own column (v103): the intent's `model` stays the bare id
 * that runs, segments and displays use, while the effort the TUI should honour
 * is recorded beside it. Returns `null` when no intent carries a model.
 */
export function configuredSessionSelection(
  store: Store,
  ticketId: number,
  launchId?: string,
): ConfiguredSessionSelection | null {
  if (launchId !== undefined) {
    const intent = getSessionLaunchIntent(store, launchId);
    if (intent !== undefined) {
      return intent.model === null ? null : { model: intent.model, effort: intent.effort };
    }
  }
  const row = store.db
    .prepare(
      `SELECT model, effort FROM session_launch_intents
        WHERE ticket_id = ? AND model IS NOT NULL
          AND status IN ('pending','confirmed')
        ORDER BY created_at DESC, id DESC
        LIMIT 1`,
    )
    .get(ticketId) as { model: string; effort: string | null } | undefined;
  return row === undefined ? null : { model: row.model, effort: row.effort };
}

/**
 * T1005: the first model step of an opencode2 session reported a model that
 * differs from the configured one. Record a durable host event on the ticket
 * naming BOTH models. Observation only — the session is never stopped here.
 *
 * Both halves of the configured selection count: a different provider/model is
 * a mismatch, and so is an effort the TUI ignored (configured `#max`, observed
 * `#high`). An absent observed variant is not compared — the bridge only
 * forwards one it has, and "unknown" must not read as "different".
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
    const selection = configuredSessionSelection(store, ticketId, launchId);
    if (selection === null) return false;
    // The v103 column is authoritative; an older intent (or a unit fixture) may
    // still carry the effort joined onto the model as `#effort`.
    const [modelPart, effortPart] = splitEffort(selection.model);
    const configuredModel = modelPart;
    const configuredEffort = selection.effort || effortPart;
    const actualModel = `${observed.providerID}/${observed.modelID}`;
    const modelMismatch = configuredModel !== actualModel;
    const effortMismatch =
      configuredEffort !== undefined &&
      observed.variant !== undefined &&
      configuredEffort !== observed.variant;
    if (!modelMismatch && !effortMismatch) return false;
    const expected =
      configuredEffort !== undefined ? `${configuredModel}#${configuredEffort}` : configuredModel;
    const actual =
      observed.variant !== undefined ? `${actualModel}#${observed.variant}` : actualModel;
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

/** `provider/model#effort` → its two halves; `#effort` is optional. */
function splitEffort(model: string): [string, string | undefined] {
  const hash = model.indexOf('#');
  if (hash < 0) return [model, undefined];
  return [model.slice(0, hash), model.slice(hash + 1) || undefined];
}
