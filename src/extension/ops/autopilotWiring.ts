import type { AutopilotDeps, FixOutcome } from './autopilotOps.js';
import type { ConflictRoundResult } from './conflictResolveOps.js';
import type { CiActionsInput } from './ciActionsWiring.js';
import { formatId } from '../../model/entityId.js';
import { sendCiFailureAction } from './ciActionsWiring.js';
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
 * pre-round sync (AC-46) is an environment blocker. Every other refusal is a plain
 * failure. Neither path reaches a host fallback: the round runs where it is placed or it does not run.
 */
export function conflictOutcome(result: ConflictRoundResult): FixOutcome {
  if (result.kind === 'sent') return { kind: 'sent' };
  return result.cause === 'sandbox-sync'
    ? { kind: 'env-blocker', reason: result.reason }
    : { kind: 'failed', reason: result.reason };
}

/**
 * Run "Send CI failure to agent" without the click: the confirm is answered yes,
 * and an error from the action (a gh failure) becomes a `failed` outcome.
 * The action moves nothing when a fetch fails, so the ticket stays in ship.
 */
export async function ciOutcome(input: CiActionsInput): Promise<FixOutcome> {
  let failure: string | null = null;
  await sendCiFailureAction({
    ...input,
    confirm: async () => true,
    error: (message) => { failure = message; input.error(message); },
  });
  return failure === null ? { kind: 'sent' } : { kind: 'failed', reason: failure };
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
  if (running.length >= caps.total) return true;
  return self.subtaskParentId !== null && running.filter((t) => t.subtaskParentId === self.subtaskParentId).length >= caps.perParent;
}

/** One pass over the ship tickets of the bound project. Never throws; a failure only delays the next pass. */
export async function autopilotSweep(d: AutopilotSweepDeps): Promise<number> {
  const projectId = d.projectId();
  if (projectId === undefined) return 0;
  const tickets = listTickets(d.store, { projectId });
  let acted = 0;
  for (const t of tickets) {
    if (t.stageCurrent !== 'ship') continue;
    try {
      const seams = d.seamsFor(t.id);
      const result = await autopilotTick({
        store: d.store, ticketId: t.id, key: t.key ?? formatId('ticket', t.id),
        config: () => d.manifest()?.autopilot,
        controls: seams.controls,
        sessionRunning: seams.sessionRunning,
        concurrencyFull: () => concurrencyFullFor(tickets, t, d.caps()),
        ...actionSeams(seams.resolveRound, seams.sendCi),
        note: (title, body) => void postAgentNote(d.store, { projectId, fromTicketId: t.id, title, body }),
        debug: d.debug,
      });
      if (result.kind === 'armed' || result.kind === 'parked') acted += 1;
    } catch (err) {
      d.debug(`[ship] autopilot ticket ${t.key ?? formatId('ticket', t.id)}: sweep failed (${err instanceof Error ? err.message : String(err)})`);
    }
  }
  if (acted > 0) d.changed();
  return acted;
}
