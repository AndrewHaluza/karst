import type { Store } from '../../store/db.js';
import { getPlanningSession } from '../../store/planningSessions.js';
import {
  discardProposal,
  getProposal,
  markProposalAccepted,
  proposalPayloadEquals,
  setProposalPriorityOverride,
  type PlanningProposal,
  type ProposalStatus,
} from '../../store/planningProposals.js';
import type { TicketFormPrefill } from '../../ui/ticketForm/panel.js';
import type { PriorityLevel } from '../../planning/proposal.js';
import { formatId } from '../../model/entityId.js';
import type { Notify } from './notify.js';
import { offerLowerDependents, queueOwnLevel } from './priorityCascade.js';

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
  /** `@arch:KEY` entry → doc file name, looked up in the draft's repos; absent = no doc names. */
  archDocs?(repos: string[], constraints: string[]): Record<string, string>;
  notify: Notify;
  onChange(): void;
  /** Rewrite the session's on-disk proposal index after a state change. */
  refreshIndex?(sessionId: number): void;
  debug?: (line: string) => void;
}

export interface PlanningProposalOps {
  announce(p: PlanningProposal, change?: 'updated'): Promise<void>;
  review(id: number): Promise<void>;
  /**
   * The review form prefill of a proposal that is pending in this project, built silently
   * (no notification). A restored review form uses it to link itself to its proposal again.
   */
  prefillFor(id: number): TicketFormPrefill | undefined;
  /**
   * The stored verdict on a proposal of this project. `accepted` is written when the user saves
   * the review form, so a restored form reads it to tell a committed ticket from a draft row.
   */
  outcomeFor(id: number): { status: ProposalStatus; ticketId: number | null } | undefined;
  discard(id: number): Promise<void>;
  /** Set (or clear with `null`) the user's priority on a pending draft of this project. */
  setPriority(id: number, level: PriorityLevel | null): Promise<void>;
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
      await deps.notify.error(`Draft ${formatId('draft', id)} was not found.`);
      return undefined;
    }
    if (p.status !== 'pending') {
      debug(`proposal ${id}: already ${p.status}`);
      await deps.notify.error(`Draft ${formatId('draft', id)} is already ${p.status}.`);
      return undefined;
    }
    return p;
  }

  async function guarded(what: string, id: number, fn: () => void): Promise<void> {
    try {
      fn();
    } catch (e) {
      debug(`proposal ${id}: ${what} failed: ${errText(e)}`);
      await deps.notify.error(`Couldn't ${what} draft ${formatId('draft', id)}: ${errText(e)}`);
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
      const verb = change === 'updated' ? 'updated' : 'proposes';
      const text = `Plan ${formatId('plan', p.sessionId)} "${session?.title ?? '?'}" ${verb} ${formatId('draft', p.id)}: "${title}" `
        + `(description ${description.length} chars, summary ${summary.length} chars).`;
      const choice = await deps.choose(text, p);
      debug(`proposal ${p.id}: choice ${choice ?? 'dismissed'}`);
      if (choice === 'review') await ops.review(p.id);
      else if (choice === 'discard') await ops.discard(p.id);
    },

    prefillFor(id) {
      const p = getProposal(deps.store, id);
      const session = p ? getPlanningSession(deps.store, p.sessionId) : undefined;
      if (!p || p.status !== 'pending' || !session || session.projectId !== deps.projectId()) return undefined;
      return prefillOf(p);
    },

    outcomeFor(id) {
      const p = getProposal(deps.store, id);
      const session = p ? getPlanningSession(deps.store, p.sessionId) : undefined;
      if (!p || !session || session.projectId !== deps.projectId()) return undefined;
      return { status: p.status, ticketId: p.ticketId };
    },

    async review(id) {
      const p = await pending(id);
      if (!p) return;
      deps.openForm(prefillOf(p));
    },

    async discard(id) {
      const p = await pending(id);
      if (!p) return;
      await guarded('discard', id, () => {
        const pruned = discardProposal(deps.store, id);
        if (pruned.length > 0) {
          const list = pruned.map((n) => formatId('draft', n)).join(', ');
          const verb = pruned.length === 1 ? 'no longer waits' : 'no longer wait';
          deps.notify.warn(`Draft ${formatId('draft', id)} was discarded; ${list} ${verb} on it.`);
        }
        // A pruned dependent may sit in another session: refresh each session once.
        const sessions = new Set([p.sessionId]);
        for (const n of pruned) {
          const other = getProposal(deps.store, n);
          if (other) sessions.add(other.sessionId);
        }
        for (const sessionId of sessions) refresh(sessionId);
      });
    },

    async setPriority(id, level) {
      const p = await pending(id);
      if (!p) return;
      const itemId = formatId('draft', id);
      const before = queueOwnLevel(deps, itemId);
      await guarded('set the priority of', id, () => {
        setProposalPriorityOverride(deps.store, id, level);
        refresh(p.sessionId);
      });
      await offerLowerDependents({ ...deps, refreshIndex: refresh }, itemId, before);
    },
  };
  return ops;

  /** The review form prefill of a proposal; `onCreated` links the saved ticket to it. */
  function prefillOf(p: PlanningProposal): TicketFormPrefill {
    const id = p.id;
    const { title, description, summary, repos, constraints = [] } = p.payload;
    const reviewed = p.payload;
    return {
      draftId: id,
      title,
      description,
      summary,
      repos,
      constraints,
      constraintDocs: deps.archDocs?.(repos, constraints) ?? {},
      warnings: p.warnings,
      onCreated: (ticketId) =>
        void guarded('link', id, () => {
          const current = getProposal(deps.store, id);
          markProposalAccepted(deps.store, id, ticketId, reviewed);
          // The form's ticket is what the human saw and saved, so it is
          // linked regardless; but if the agent revised the draft while the
          // form was open, say so rather than dropping it silently.
          if (current && !proposalPayloadEquals(current.payload, reviewed)) {
            deps.notify.warn(
              `Draft ${formatId('draft', id)} was revised while you were editing; your saved ticket is linked and the newer revision was discarded.`,
            );
          }
          refresh(p.sessionId);
        }),
    };
  }
}
