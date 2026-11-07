import type { Store } from '../../store/db.js';
import { formatId } from '../../model/entityId.js';
import { isFinishedStage } from '../../model/types.js';
import { getTicket, listTickets } from '../../store/tickets.js';
import { postAgentNote } from '../../store/bulletinNotes.js';
import {
  AUTOPILOT_OVERRIDES, listAutopilotBudgets, clearConflictRound, setAutopilotOverride, setAutopilotStopped, type AutopilotKind, type AutopilotOverride,
} from '../../store/autopilot.js';
import { approveOneMore, clearParkBlock, stopAutopilot } from './autopilotOps.js';

/** Host commands for autopilot (T973): the host-agnostic half. The vscode binding only supplies the pickers. */
export interface AutopilotCommandDeps {
  readonly store: Store;
  readonly projectId: () => number | undefined;
  readonly pickTicket: (picks: ReadonlyArray<{ label: string; ticketId: number }>, placeHolder: string) => Promise<number | undefined>;
  readonly pick: <T extends string>(choices: readonly T[], placeHolder: string) => Promise<T | undefined>;
  readonly say: (message: string) => void;
  readonly debug: (message: string) => void;
  /** "Stop now": end the session. True when the stop reached a session this window holds; false when it did not. */
  readonly stopSession: (ticketId: number) => Promise<boolean>;
  /** Disarm the ticket's conflict round, so a later manual session gets no auto-delivery (T996). */
  readonly dropConflictRound: (ticketId: number) => void;
}

function keyOf(store: Store, ticketId: number): string {
  return getTicket(store, ticketId).key ?? formatId('ticket', ticketId);
}

async function resolveTicket(d: AutopilotCommandDeps, given: number | undefined, placeHolder: string): Promise<number | undefined> {
  if (given !== undefined) return given;
  const projectId = d.projectId();
  if (projectId === undefined) return undefined;
  // Any open ticket: an override or a stop must reach a ticket that is not at ship yet (or was sent back to Implement).
  const picks = listTickets(d.store, { projectId }).filter((t) => !isFinishedStage(t.stageCurrent))
    .map((t) => ({ label: t.key ?? formatId('ticket', t.id), ticketId: t.id }));
  return d.pickTicket(picks, placeHolder);
}

function noteFor(d: AutopilotCommandDeps, ticketId: number) {
  const projectId = d.projectId();
  return (title: string, body: string): void => {
    if (projectId !== undefined) postAgentNote(d.store, { projectId, fromTicketId: ticketId, title, body });
  };
}

/** Set the per-ticket override (inherit|on|off). A change also clears a paused or spent state, so the next sweep re-evaluates. */
export async function setOverrideCommand(d: AutopilotCommandDeps, ticketId?: number, mode?: AutopilotOverride): Promise<void> {
  const id = await resolveTicket(d, ticketId, 'Set auto-fix mode for which ticket?');
  if (id === undefined) return;
  const chosen = mode ?? await d.pick(AUTOPILOT_OVERRIDES, 'Auto-fix mode');
  if (chosen === undefined || !AUTOPILOT_OVERRIDES.includes(chosen)) return;
  setAutopilotOverride(d.store, id, chosen);
  if (chosen === 'off') { d.dropConflictRound(id); clearConflictRound(d.store, id); }
  clearParkBlock(d.store, id);
  noteFor(d, id)('Autopilot: override set', `${keyOf(d.store, id)}: auto-fix mode is now ${chosen}.`);
  d.debug(`[ship] autopilot ticket ${keyOf(d.store, id)} override ${chosen}`);
  d.say(`Auto-fix mode for ${keyOf(d.store, id)}: ${chosen}.`);
}

/** Approve one more attempt for a (PR, kind): a one-off +1, no reset. */
export async function approveCommand(d: AutopilotCommandDeps, ticketId?: number, target?: { repo: string; kind: AutopilotKind }): Promise<void> {
  const id = await resolveTicket(d, ticketId, 'Approve one more auto-fix attempt for which ticket?');
  if (id === undefined) return;
  let pickTarget = target;
  if (pickTarget === undefined) {
    const rows = listAutopilotBudgets(d.store, id);
    if (rows.length === 0) { d.say(`${keyOf(d.store, id)} has no auto-fix attempt to extend.`); return; }
    const labels = rows.map((r) => `${r.repo} · ${r.kind}`);
    const label = rows.length === 1 ? labels[0] : await d.pick(labels as [string, ...string[]], 'Approve one more attempt for');
    const index = labels.indexOf(label ?? '');
    if (index < 0) return;
    pickTarget = rows[index];
  }
  if (pickTarget === undefined) return;
  approveOneMore({ store: d.store, ticketId: id, key: keyOf(d.store, id), note: noteFor(d, id), debug: d.debug }, pickTarget.repo, pickTarget.kind);
  d.say(`One more ${pickTarget.kind} attempt approved for ${keyOf(d.store, id)}.`);
}

/** Stop auto-fix for a ticket, after this round or now. */
export async function stopCommand(d: AutopilotCommandDeps, ticketId?: number, when?: 'after-round' | 'now'): Promise<void> {
  const id = await resolveTicket(d, ticketId, 'Stop auto-fix for which ticket?');
  if (id === undefined) return;
  const choice = when ?? await d.pick(['after-round', 'now'] as const, 'Stop auto-fix');
  if (choice === undefined) return;
  if (choice === 'now') {
    // The round stops with the session: nothing delivers it, and its slot is free.
    d.dropConflictRound(id);
    clearConflictRound(d.store, id);
    setAutopilotStopped(d.store, id, 'auto-fix stopped: a person stopped it');
  }
  const result = await stopAutopilot({ store: d.store, ticketId: id, key: keyOf(d.store, id), note: noteFor(d, id), debug: d.debug, stopSession: () => d.stopSession(id) }, choice);
  const key = keyOf(d.store, id);
  if (result === 'not-reached') d.say(`Auto-fix is stopped for ${key}. The stop did not reach the session: another window holds it, or none is open.`);
  else d.say(`Auto-fix stopped ${choice === 'now' ? 'now' : 'after this round'} for ${key}.`);
}
