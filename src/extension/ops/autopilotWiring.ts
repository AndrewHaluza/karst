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
 * A refused hand-off IS a sent round: the ticket already moved to Implement.
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
  // The action already moved the ticket to Implement before the hand-off: a refused launch is still a sent round.
  if (refusal !== null) input.debug(`[ship] autopilot ticket ${formatId('ticket', input.ticketId)} ci: hand-off refused (${refusal}); the ticket is in Implement`);
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

/**
 * Each auto round counts against the sub-task concurrency limit (@arch:CONCURRENCY):
 * the cap is full when the running tickets reach the total, or the running
 * children of the same parent reach the per-parent cap.
 */
export function concurrencyFullFor(
  tickets: ReadonlyArray<{ id: number; agentState: string | null; subtaskParentId: number | null }>,
  self: { id: number; subtaskParentId: number | null },
  caps: AutostartCaps,
): boolean {
  const running = tickets.filter((t) => t.agentState === 'running' && t.id !== self.id);
  // A cap of 0 (or less) means unlimited, as in pickSubtasksToStart.
  if (caps.total > 0 && running.length >= caps.total) return true;
  return caps.perParent > 0 && self.subtaskParentId !== null
    && running.filter((t) => t.subtaskParentId === self.subtaskParentId).length >= caps.perParent;
}

/** One pass over the ship tickets of the bound project. Never throws; a failure only delays the next pass. */
export async function autopilotSweep(d: AutopilotSweepDeps): Promise<number> {
  const projectId = d.projectId();
  if (projectId === undefined) return 0;
  const tickets = listTickets(d.store, { projectId });
  let acted = 0;
  const armed = new Set<number>();
  for (const t of tickets) {
    if (t.stageCurrent !== 'ship') continue;
    try {
      const seams = d.seamsFor(t.id);
      const result = await autopilotTick({
        store: d.store, ticketId: t.id, key: t.key ?? formatId('ticket', t.id),
        config: () => d.manifest()?.autopilot,
        controls: seams.controls,
        sessionRunning: seams.sessionRunning,
        concurrencyFull: () => concurrencyFullFor(tickets.map((o) => (armed.has(o.id) ? { ...o, agentState: 'running' } : o)), t, d.caps()),
        ...actionSeams(seams.resolveRound, seams.sendCi),
        note: (title, body) => void postAgentNote(d.store, { projectId, fromTicketId: t.id, title, body }),
        debug: d.debug,
      });
      if (result.kind === 'armed') armed.add(t.id);
      if (result.kind === 'armed' || result.kind === 'parked') acted += 1;
    } catch (err) {
      d.debug(`[ship] autopilot ticket ${t.key ?? formatId('ticket', t.id)}: sweep failed (${err instanceof Error ? err.message : String(err)})`);
    }
  }
  if (acted > 0) d.changed();
  return acted;
}
