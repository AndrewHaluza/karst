import type { Store } from '../../store/db.js';
import { listTickets, type TicketWithStages } from '../../store/tickets.js';
import { formatTicketRef } from '../../model/entityId.js';
import { isFinishedStage } from '../../model/types.js';
import { ticketIdArg } from './args.js';
import { closeTicketOp, reopenTicketOp, type CloseOpsDeps } from './closeOps.js';

/**
 * The palette wiring for `karst.closeTicket` / `karst.reopenTicket`
 * (`@arch:STAGEMACH`). All vscode access arrives through `CloseCommandsUi`, so
 * this stays host-agnostic and testable and `extension.ts` keeps one thin call.
 * Which ticket: the command argument, else the active ticket if it is eligible,
 * else a picker over the eligible ones.
 */
export interface CloseCommandsUi {
  registerCommand(id: string, handler: (arg?: unknown) => Promise<void>): { dispose(): void };
  showInputBox(opts: {
    title: string;
    prompt: string;
    placeHolder?: string;
    validateInput?: (value: string) => string | undefined;
  }): Promise<string | undefined>;
  pickTicket(
    picks: readonly { label: string; description: string; ticketId: number }[],
    placeHolder: string,
  ): Promise<number | undefined>;
}

export interface CloseCommandsDeps extends Omit<CloseOpsDeps, 'askReason'> {
  readonly ui: CloseCommandsUi;
  readonly projectId: () => number | undefined;
  readonly activeTicketId: () => number | undefined;
}

const closable = (t: TicketWithStages): boolean => !isFinishedStage(t.stageCurrent);
const reopenable = (t: TicketWithStages): boolean => t.stageCurrent === 'closed';

export function registerCloseCommands(deps: CloseCommandsDeps): { dispose(): void }[] {
  const { ui } = deps;

  const candidates = (eligible: (t: TicketWithStages) => boolean): TicketWithStages[] => {
    const projectId = deps.projectId();
    return listTickets(deps.store, projectId === undefined ? {} : { projectId }).filter(eligible);
  };

  const resolve = async (
    arg: unknown,
    eligible: (t: TicketWithStages) => boolean,
    placeHolder: string,
  ): Promise<number | undefined> => {
    const given = ticketIdArg(arg);
    if (given !== undefined) return given;
    const pool = candidates(eligible);
    const active = deps.activeTicketId();
    if (pool.some((t) => t.id === active)) return active;
    return ui.pickTicket(
      pool.map((t) => ({
        label: formatTicketRef(t.id, t.key),
        description: t.title ?? '',
        ticketId: t.id,
      })),
      placeHolder,
    );
  };

  const askReason: CloseOpsDeps['askReason'] = async () => {
    const reason = await ui.showInputBox({
      title: 'Close ticket — resolved outside karst',
      prompt: 'Why is this ticket closed? (e.g. "Sam did it in CU-123"). Nothing is verified.',
      validateInput: (v) => (v.trim() === '' ? 'A reason is required.' : undefined),
    });
    if (reason === undefined) return undefined;
    const ref = await ui.showInputBox({
      title: 'Close ticket — reference (optional)',
      prompt: 'A link, SHA or ticket key for the outside work. Stored, never verified.',
    });
    // Escape on the optional prompt cancels the whole close, as it does on the
    // first one; an empty submit just means "no reference".
    if (ref === undefined) return undefined;
    return ref.trim() === '' ? { reason } : { reason, ref };
  };

  const opsDeps: CloseOpsDeps = { ...deps, askReason };

  return [
    ui.registerCommand('karst.closeTicket', async (arg) => {
      const id = await resolve(arg, closable, 'Close which ticket? (resolved outside karst)');
      if (id !== undefined) await closeTicketOp(opsDeps, id);
    }),
    ui.registerCommand('karst.reopenTicket', async (arg) => {
      const id = await resolve(arg, reopenable, 'Reopen which closed ticket?');
      if (id !== undefined) await reopenTicketOp(opsDeps, id);
    }),
  ];
}
