import type { Store } from '../../store/db.js';
import { getPlanningSession } from '../../store/planningSessions.js';
import {
  acceptProposal,
  discardProposal,
  getProposal,
  markProposalAccepted,
  proposalPayloadEquals,
  type PlanningProposal,
} from '../../store/planningProposals.js';
import type { TicketFormPrefill } from '../../ui/ticketForm/panel.js';
import type { Notify } from './notify.js';

/**
 * The human confirmation of planning proposals (vscode-free). A proposal is
 * agent-authored, so it becomes a ticket ONLY through an explicit user action
 * with its content visible: Create (after a full-content preview the user
 * accepts) or Review (the prefilled ticket form, which the user saves).
 * Dismissing anything leaves the proposal pending.
 */

export type ProposalChoice = 'review' | 'create' | 'discard';

export interface PlanningProposalOpsDeps {
  store: Store;
  projectId(): number | undefined;
  /** Modal showing `proposalPreview(p)`; true only on an explicit accept. */
  confirmPreview(p: PlanningProposal): Promise<boolean>;
  /** Notification with Review (first), Create, Discard; undefined = dismissed. */
  choose(text: string, p: PlanningProposal): Promise<ProposalChoice | undefined>;
  openForm(prefill: TicketFormPrefill): void;
  /** Show the draft's full content read-only (no accept, no edit). */
  showDraft(p: PlanningProposal): Promise<void>;
  notify: Notify;
  onChange(): void;
  /** Rewrite the session's on-disk proposal index after a state change. */
  refreshIndex?(sessionId: number): void;
  debug?: (line: string) => void;
}

export interface PlanningProposalOps {
  announce(p: PlanningProposal, change?: 'updated'): Promise<void>;
  review(id: number): Promise<void>;
  view(id: number): Promise<void>;
  create(id: number): Promise<void>;
  discard(id: number): Promise<void>;
}

/** The full, untruncated content the user confirms. */
export function proposalPreview(p: PlanningProposal): string {
  const { title, description, summary, repos } = p.payload;
  return [
    `Title: ${title}`,
    `Repositories: ${repos.length ? repos.join(', ') : '(none)'}`,
    '',
    'Summary:',
    summary || '(empty)',
    '',
    'Description:',
    description || '(empty)',
  ].join('\n');
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

  /**
   * The index is a convenience, never the source of truth: a failed refresh
   * (mkdir/write/rename in the agent-writable scratch) must not turn a
   * committed accept or discard into a user-facing failure.
   */
  function refresh(sessionId: number): void {
    try {
      deps.refreshIndex?.(sessionId);
    } catch (e) {
      debug(`session ${sessionId}: proposal index refresh failed: ${errText(e)}`);
    }
  }

  const ops: PlanningProposalOps = {
    async announce(p, change) {
      const session = getPlanningSession(deps.store, p.sessionId);
      const { title, description, summary } = p.payload;
      const verb = change === 'updated' ? 'updated its draft' : 'proposes a ticket';
      const text = `Planning session "${session?.title ?? '?'}" (#${p.sessionId}) ${verb}: "${title}" `
        + `(description ${description.length} chars, summary ${summary.length} chars).`;
      const choice = await deps.choose(text, p);
      debug(`proposal ${p.id}: choice ${choice ?? 'dismissed'}`);
      if (choice === 'review') await ops.review(p.id);
      else if (choice === 'create') await ops.create(p.id);
      else if (choice === 'discard') await ops.discard(p.id);
    },

    async review(id) {
      const p = await pending(id);
      if (!p) return;
      const { title, description, repos } = p.payload;
      const reviewed = p.payload;
      deps.openForm({
        title,
        description,
        repos,
        onCreated: (ticketId) =>
          void guarded('link', id, () => {
            const current = getProposal(deps.store, id);
            markProposalAccepted(deps.store, id, ticketId);
            // The form's ticket is what the human saw and saved, so it is
            // linked regardless; but if the agent revised the draft while the
            // form was open, say so rather than dropping it silently.
            if (current && !proposalPayloadEquals(current.payload, reviewed)) {
              deps.notify.warn(
                `Planning draft #${id} was revised while you were editing; your saved ticket is linked and the newer revision was discarded.`,
              );
            }
            refresh(p.sessionId);
          }),
      });
    },

    async view(id) {
      const p = await pending(id);
      if (!p) return;
      debug(`proposal ${id}: shown read-only`);
      await deps.showDraft(p);
    },

    async create(id) {
      const p = await pending(id);
      if (!p) return;
      if (!(await deps.confirmPreview(p))) {
        debug(`proposal ${id}: preview declined, stays pending`);
        return;
      }
      const projectId = deps.projectId();
      await guarded('create a ticket from', id, () => {
        const ticketId = acceptProposal(deps.store, id, {
          ...(projectId === undefined ? {} : { projectId }),
          expectedPayload: p.payload,
        });
        refresh(p.sessionId);
        debug(`proposal ${id}: accepted as ticket ${ticketId}`);
      });
    },

    async discard(id) {
      const p = await pending(id);
      if (!p) return;
      await guarded('discard', id, () => {
        discardProposal(deps.store, id);
        refresh(p.sessionId);
      });
    },
  };
  return ops;
}
