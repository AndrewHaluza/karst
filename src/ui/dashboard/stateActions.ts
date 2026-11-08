import type { Store } from '../../store/db.js';
import { mergeGateState } from '../../workflow/mergeGate.js';
import { resetStageState } from '../../workflow/resetStage.js';
import { sendBackState } from '../../workflow/sendBack.js';
import { retryGateState } from '../../workflow/retryGate.js';
import { prFeedbackFixState } from '../../workflow/prFeedbackFix.js';
import { countOpenPrFeedback } from '../../store/prFeedback.js';
import { ciFailureState } from '../../workflow/ciFailure.js';
import { rebaseState } from '../../workflow/rebaseState.js';
import { deliverTargets } from '../../workflow/deliverState.js';
import type { DashboardAgentContext, DashboardState } from './stateTypes.js';
import { deliverFactsFor } from '../../store/deliverFacts.js';
import type { DeliverFacts } from '../../model/inside/deliver.js';

/** The auto-deliver facts of a ticket, only when a run left a record (a ticket that never auto-delivered carries none). */
function readDeliverAuto(store: Store, ticketId: number): DeliverFacts | undefined {
  const f = deliverFactsFor(store, ticketId);
  return f.running === null && f.failures.length === 0 && f.takenOver === null ? undefined : f;
}

/** The action-availability reads of one snapshot, in their fixed order. */
export function readActionStates(store: Store, ticketId: number, agentContext: DashboardAgentContext) {
  // ONE read of the merge gate for the whole snapshot: the Now line and the
  // track's needs-you wording must not describe the same three-valued fact from
  // two different reads.
  const mergeGate = mergeGateState(store, ticketId);
  // ONE read of the recovery action's availability, for the same reason: the
  // stage header's ⋯ menu and the host's confirm path must agree about whether
  // "Send back to Implement" exists at all. Derived here rather than on click
  // so a stale panel can never offer an action the host would refuse — and the
  // host re-derives it before mutating anyway.
  const sendBack = sendBackState(store, ticketId);
  const rerunGate = retryGateState(store, ticketId);
  const resetStage = resetStageState(store, ticketId);
  // ONE read of the PR-feedback action's availability, for the same reason: the
  // ship header's ⋯ menu and the host's confirm path must agree about whether
  // "Address pull request feedback" exists at all.
  const prFeedbackFix = prFeedbackFixState(store, ticketId);
  // Same single-read rule for the two ship CI actions (T715).
  const ciFailure = ciFailureState(store, ticketId);
  const rebase = rebaseState(store, ticketId);
  const undelivered = deliverTargets(store, ticketId).available ? agentContext.undelivered?.(ticketId) : undefined;
  const openPrFeedback = countOpenPrFeedback(store, ticketId);
  return {
    mergeGate,
    sendBack,
    rerunGate,
    resetStage,
    prFeedbackFix,
    ciFailure,
    rebase,
    undelivered,
    deliverAuto: readDeliverAuto(store, ticketId),
    openPrFeedback,
  };
}

/** The ship CI/rebase/deliver slots of the dashboard state, projected from the reads above. */
export function shipActionViews(
  states: Pick<ReturnType<typeof readActionStates>, 'ciFailure' | 'rebase' | 'undelivered' | 'deliverAuto'>,
  stageCurrent: string | null,
): Pick<DashboardState, 'ciFailure' | 'rebase' | 'deliver'> {
  const { ciFailure, rebase, undelivered, deliverAuto } = states;
  return {
    ciFailure: ciFailure.available
      ? { available: true, repos: ciFailure.prs.map((p) => p.repo) }
      : { available: false, repos: [] },
    rebase: rebase.available ? { available: true, stage: stageCurrent ?? undefined } : { available: false },
    deliver: {
      ...(undelivered
        ? { available: true, notOnPr: undelivered.hostAhead + undelivered.sandboxAhead, inSandbox: undelivered.sandboxAhead }
        : { available: false, notOnPr: 0, inSandbox: 0 }),
      ...(deliverAuto ? { auto: deliverAuto } : {}),
    },
  };
}
