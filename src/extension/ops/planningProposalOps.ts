import type { Store } from '../../store/db.js';
import { getPlanningSession } from '../../store/planningSessions.js';
import {
  discardProposal,
  getProposal,
  markProposalAccepted,
  type PlanningProposal,
} from '../../store/planningProposals.js';
import type { TicketFormPrefill } from '../../ui/ticketForm/panel.js';
import type { Notify } from './notify.js';

/**
 * The human confirmation of planning proposals (vscode-free). A proposal is
 * agent-authored, so it becomes a ticket ONLY through an explicit user action
 * with its content visible: Review opens the prefilled ticket form, which the
 * user edits and saves. Dismissing anything leaves the proposal pending.
 */

export type ProposalChoice = 'review' | 'discard';

export interface PlanningProposalOpsDeps {
  store: Store;
  projectId(): number | undefined;
  /** Notification with Review (first), Discard; undefined = dismissed. */
  choose(text: string, p: PlanningProposal): Promise<ProposalChoice | undefined>;
  openForm(prefill: TicketFormPrefill): void;
  notify: Notify;
  onChange(): void;
  debug?: (line: string) => void;
}

export interface PlanningProposalOps {
  announce(p: PlanningProposal): Promise<void>;
  review(id: number): Promise<void>;
  discard(id: number): Promise<void>;
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export function createPlanningProposalOps(deps: PlanningProposalOpsDeps): PlanningProposalOps {
  const debug = (line: string): void => deps.debug?.(`[planning] ${line}`);

  /** The proposal, only when it is pending and belongs to this window's project. */
  async function pending(id: number): Promise<PlanningProposal | undefined> {
    const p = getProposal(deps.store, id);
    const session = p ? getPlanningSession(deps.store, p.sessionId) : undefined;
    if (!p || !session || session.projectId !== deps.projectId()) {
      debug(`proposal ${id}: not found in this project`);
      await deps.notify.error(`Planning proposal #${id} was not found.`);
      return undefined;
    }
    if (p.status !== 'pending') {
      debug(`proposal ${id}: already ${p.status}`);
      await deps.notify.error(`Planning proposal #${id} is already ${p.status}.`);
      return undefined;
    }
    return p;
  }

  async function guarded(what: string, id: number, fn: () => void): Promise<void> {
    try {
      fn();
    } catch (e) {
      debug(`proposal ${id}: ${what} failed: ${errText(e)}`);
      await deps.notify.error(`Couldn't ${what} planning proposal #${id}: ${errText(e)}`);
    }
    deps.onChange();
  }

  const ops: PlanningProposalOps = {
    async announce(p) {
      const session = getPlanningSession(deps.store, p.sessionId);
      const { title, description, summary } = p.payload;
      const text = `Planning session "${session?.title ?? '?'}" (#${p.sessionId}) proposes a ticket: "${title}" `
        + `(description ${description.length} chars, summary ${summary.length} chars).`;
      const choice = await deps.choose(text, p);
      debug(`proposal ${p.id}: choice ${choice ?? 'dismissed'}`);
      if (choice === 'review') await ops.review(p.id);
      else if (choice === 'discard') await ops.discard(p.id);
    },

    async review(id) {
      const p = await pending(id);
      if (!p) return;
      const { title, description, summary, repos } = p.payload;
      deps.openForm({
        title,
        description,
        summary,
        repos,
        onCreated: (ticketId) => void guarded('link', id, () => markProposalAccepted(deps.store, id, ticketId)),
      });
    },

    async discard(id) {
      if (!(await pending(id))) return;
      await guarded('discard', id, () => discardProposal(deps.store, id));
    },
  };
  return ops;
}
