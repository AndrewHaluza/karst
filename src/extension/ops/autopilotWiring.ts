import type { AutopilotDeps, FixOutcome } from './autopilotOps.js';
import type { CiActionsInput } from './ciActionsWiring.js';
import { formatId } from '../../model/entityId.js';
import { sendCiFailureAction } from './ciActionsWiring.js';
import { ciFailureState } from '../../workflow/ciFailure.js';
import type { Store } from '../../store/db.js';
import type { Manifest } from '../../manifest/types.js';
import { listTickets } from '../../store/tickets.js';
import { BULLETIN_BODY_MAX, BULLETIN_TITLE_MAX, postAgentNote } from '../../store/bulletinNotes.js';
import type { AutostartCaps } from '../../workflow/subtaskAutostart.js';
import { autopilotTick } from './autopilotOps.js';
import { graphRunIdsForTicket } from '../../store/graph/graphRuns.js';
import { HOLDS_SLOT_SQL } from '../../store/autostart.js';

/**
 * Binds the autopilot engine to the real ship actions. Only the mapping lives here:
 * the engine decides, the existing click paths act (no new sandbox code path).
 */

/**
 * Run "Send CI failure to agent" without the click: the confirm is answered yes.
 * Autopilot never shows a toast: the info and error text go to the debug log only.
 * A gh failure and a missing failure are NOT a sent round, so each becomes a `failed` outcome.
 * A refused hand-off is NOT a sent round: it returns `failed` (the ticket already moved to Implement, so the engine pauses).
 */
export async function ciOutcome(input: CiActionsInput): Promise<FixOutcome> {
  if (!ciFailureState(input.store, input.ticketId).available) return { kind: 'failed', reason: 'no failing CI to send' };
  let failure: string | null = null;
  let refusal: string | null = null;
  await sendCiFailureAction({
    ...input,
    confirm: async () => true,
    info: (message) => input.debug(`[ship] autopilot ticket ${formatId('ticket', input.ticketId)} ci: ${message}`),
    error: (message) => { failure = message; input.debug(`[ship] autopilot ticket ${formatId('ticket', input.ticketId)} ci error: ${message}`); },
    handOff: (prompt) => { refusal = input.handOff(prompt); return refusal; },
  });
  if (failure !== null) return { kind: 'failed', reason: failure };
  // The ticket already moved to Implement, but no session got the task: the round did not reach the agent.
  // The engine refunds the attempt and pauses autopilot with a visible reason (it cannot park the ship row any more).
  if (refusal !== null) {
    input.debug(`[ship] autopilot ticket ${formatId('ticket', input.ticketId)} ci: hand-off refused (${refusal}); the ticket is in Implement`);
    return { kind: 'failed', reason: refusal };
  }
  return { kind: 'sent' };
}

/** The per-ticket host seams: ownership, session state, placement and the CI action. */
export interface TicketSeams {
  readonly controls: () => boolean;
  readonly sessionRunning: () => boolean;
  readonly isHostTicket: () => Promise<boolean>;
  readonly sendCi: () => Promise<FixOutcome>;
}

export interface AutopilotSweepDeps {
  readonly store: Store;
  readonly projectId: () => number | undefined;
  readonly manifest: () => Manifest | undefined;
  readonly caps: () => AutostartCaps;
  readonly seamsFor: (ticketId: number) => TicketSeams;
  readonly debug: (message: string) => void;
  /** Called once per sweep that changed any ticket, so the views refresh. */
  readonly changed: () => void;
}

/** A sub-task that holds a concurrency slot (arch:CONCURRENCY). */
export interface SlotHolder { readonly id: number; readonly subtaskParentId: number }

/**
 * Every sub-task of the project that holds a slot: the same rule the autostart picker uses (`HOLDS_SLOT_SQL`).
 */
export function listSlotHolders(store: Store, projectId: number): SlotHolder[] {
  const rows = store.db
    .prepare(
      `SELECT s.id AS id, s.subtask_parent_id AS parent FROM tickets s
        WHERE s.project_id = ? AND s.subtask_parent_id IS NOT NULL
          AND ${HOLDS_SLOT_SQL}`,
    )
    .all(projectId) as Array<{ id: number; parent: number }>;
  return rows.map((r) => ({ id: r.id, subtaskParentId: r.parent }));
}

/**
 * Each auto round of a sub-task counts against the sub-task concurrency limit (@arch:CONCURRENCY): the round
 * needs a slot like a started sub-task does. The cap is full when the slot holders reach the total, or the
 * holders of the same parent reach the per-parent cap. A ticket that is not a sub-task has no slot to take.
 * A cap of 0 (or less) means unlimited, as in pickSubtasksToStart.
 */
export function concurrencyFullFor(
  holders: readonly SlotHolder[],
  self: { id: number; subtaskParentId: number | null },
  caps: AutostartCaps,
): boolean {
  if (self.subtaskParentId === null) return false;
  const others = holders.filter((h) => h.id !== self.id);
  if (caps.total > 0 && others.length >= caps.total) return true;
  return caps.perParent > 0 && others.filter((h) => h.subtaskParentId === self.subtaskParentId).length >= caps.perParent;
}

/** Cut `text` to `max` characters, ending with an ellipsis when it was longer. */
function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}\u2026`;
}

/**
 * Post a bulletin note that always fits the note rules: a one-line title of at most 120 characters,
 * a body of at most 4096 characters, no control characters. A long or multi-line park reason
 * (a gh error text) must not make the post throw and lose the note.
 */
export function postAutopilotNote(store: Store, projectId: number, ticketId: number, title: string, body: string, debug: (m: string) => void): void {
  const clean = (t: string): string => t.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ');
  const oneLine = clean(title).replace(/\s+/g, ' ').trim();
  try {
    postAgentNote(store, {
      projectId, fromTicketId: ticketId,
      title: clip(oneLine === '' ? 'Autopilot' : oneLine, BULLETIN_TITLE_MAX),
      body: clip(clean(body).trim() === '' ? 'Autopilot' : clean(body).trim(), BULLETIN_BODY_MAX),
    });
  } catch (err) {
    debug(`[ship] autopilot note failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** One pass over the ship tickets of the bound project. Never throws; a failure only delays the next pass. */
export async function autopilotSweep(d: AutopilotSweepDeps): Promise<number> {
  const projectId = d.projectId();
  if (projectId === undefined) return 0;
  const tickets = listTickets(d.store, { projectId });
  let acted = 0;
  // Sub-tasks armed earlier in this pass hold a seat the stored rows do not show yet.
  const armed = new Map<number, SlotHolder>();
  for (const t of tickets) {
    if (t.stageCurrent !== 'ship') continue;
    try {
      const seams = d.seamsFor(t.id);
      const result = await autopilotTick({
        store: d.store, ticketId: t.id, key: t.key ?? formatId('ticket', t.id),
        config: () => d.manifest()?.autopilot,
        controls: seams.controls,
        sessionRunning: seams.sessionRunning,
        concurrencyFull: () => concurrencyFullFor([...new Map([...listSlotHolders(d.store, projectId), ...armed.values()].map((h) => [h.id, h])).values()], t, d.caps()),
        isHostTicket: seams.isHostTicket,
        isGraphTicket: () => graphRunIdsForTicket(d.store.db, t.id).length > 0,
        sendCiFailure: seams.sendCi,
        note: (title, body) => postAutopilotNote(d.store, projectId, t.id, title, body, d.debug),
        debug: d.debug,
      });
      if (result.kind === 'armed' && t.subtaskParentId !== null) armed.set(t.id, { id: t.id, subtaskParentId: t.subtaskParentId });
      if (result.kind === 'armed' || result.kind === 'parked') acted += 1;
    } catch (err) {
      d.debug(`[ship] autopilot ticket ${t.key ?? formatId('ticket', t.id)}: sweep failed (${err instanceof Error ? err.message : String(err)})`);
    }
  }
  if (acted > 0) d.changed();
  return acted;
}
