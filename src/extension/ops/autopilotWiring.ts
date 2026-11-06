import type { AutopilotDeps, FixOutcome } from './autopilotOps.js';
import type { ConflictRoundResult } from './conflictResolveOps.js';
import type { CiActionsInput } from './ciActionsWiring.js';
import { formatId } from '../../model/entityId.js';
import { sendCiFailureAction } from './ciActionsWiring.js';
import { ciFailureState } from '../../workflow/ciFailure.js';
import type { Store } from '../../store/db.js';
import type { Manifest } from '../../manifest/types.js';
import { listTickets } from '../../store/tickets.js';
import { postAgentNote } from '../../store/bulletinNotes.js';
import type { AutostartCaps } from '../../workflow/subtaskAutostart.js';
import { autopilotTick } from './autopilotOps.js';
import { HOLDS_SLOT_SQL } from '../../store/autostart.js';

/**
 * Binds the autopilot engine to the real ship actions. Only the mapping lives here:
 * the engine decides, the existing click paths act (no new sandbox code path).
 */

/**
 * A refused conflict round maps to an outcome. A dirty or diverged clone at the
 * pre-round sync (AC-46) and a failed session launch are environment blockers. Every other refusal is a plain
 * failure. Neither path reaches a host fallback: the round runs where it is placed or it does not run.
 */
export function conflictOutcome(result: ConflictRoundResult): FixOutcome {
  if (result.kind === 'sent') return { kind: 'sent' };
  if (result.cause === 'lease-lost') return { kind: 'lease-lost' };
  return result.cause === 'sandbox-sync' || result.cause === 'launch-failed'
    ? { kind: 'env-blocker', reason: result.reason }
    : { kind: 'failed', reason: result.reason };
}

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

/** The engine seams that depend only on the two actions. */
export function actionSeams(
  resolveRound: (repo: string) => Promise<ConflictRoundResult>,
  sendCi: () => Promise<FixOutcome>,
): Pick<AutopilotDeps, 'resolveConflicts' | 'sendCiFailure'> {
  return {
    resolveConflicts: async (repo) => conflictOutcome(await resolveRound(repo)),
    sendCiFailure: sendCi,
  };
}

/** The per-ticket host seams: ownership, session state and the two actions. */
export interface TicketSeams {
  readonly controls: () => boolean;
  readonly sessionRunning: () => boolean;
  readonly resolveRound: (repo: string) => Promise<ConflictRoundResult>;
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
 * Every sub-task of the project that holds a slot: the same rule the autostart picker uses (`HOLDS_SLOT_SQL`),
 * plus a sub-task whose agent still runs at ship (a conflict round does not leave ship but does use a seat).
 */
export function listSlotHolders(store: Store, projectId: number): SlotHolder[] {
  const rows = store.db
    .prepare(
      `SELECT s.id AS id, s.subtask_parent_id AS parent FROM tickets s
        WHERE s.project_id = ? AND s.subtask_parent_id IS NOT NULL
          AND (${HOLDS_SLOT_SQL} OR (s.archived_at IS NULL AND s.stage_current = 'ship' AND s.agent_state = 'running'))`,
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
        concurrencyFull: () => concurrencyFullFor([...listSlotHolders(d.store, projectId), ...armed.values()], t, d.caps()),
        ...actionSeams(seams.resolveRound, seams.sendCi),
        note: (title, body) => void postAgentNote(d.store, { projectId, fromTicketId: t.id, title, body }),
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
