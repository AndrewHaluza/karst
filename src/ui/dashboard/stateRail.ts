import { buildStageRail } from '../../model/stageRail.js';
import { railNeeds } from '../../model/railNeeds.js';
import { needsUser } from '../../model/ticketGlyph.js';
import type { StepperCell } from '../../model/stepper.js';
import type { StageKey } from '../../model/types.js';
import type { mergeGateState } from '../../workflow/mergeGate.js';
import type { GateStageKey } from '../../workflow/fixAttempts.js';
import type { getTicket } from '../../store/tickets.js';

export interface RailInput {
  ticket: ReturnType<typeof getTicket>;
  stepper: StepperCell[];
  currentStage: StepperCell | null;
  blocked: ReturnType<typeof needsUser>;
  cellOf: (key: StageKey) => StepperCell;
  mergeGate: ReturnType<typeof mergeGateState>;
  mergeableRepos: string[];
  fixCapFor: (gate: GateStageKey) => number;
}

export function buildRail({
  ticket,
  stepper,
  currentStage,
  blocked,
  cellOf,
  mergeGate,
  mergeableRepos,
  fixCapFor,
}: RailInput) {
  // A failed ship parks on the user (Retry ship) even though the ticket-level
  // glyph/badge keep reading the failure (red), so only the rail widens `blocked`.
  const shipCell = cellOf('ship');
  const shipFailed =
    ticket.stageCurrent === 'ship' &&
    shipCell.status === 'failed' &&
    shipCell.blocked?.kind !== 'awaiting-merge';
  const needsYou = blocked || shipFailed;
  return buildStageRail(stepper, ticket.stages, {
    current: ticket.stageCurrent,
    needsUser: needsYou,
    needs: needsYou
      ? railNeeds({
          stage: ticket.stageCurrent,
          blockedKind: currentStage?.blocked?.kind,
          agentWaiting: (ticket.agentState ?? 'none') === 'waiting',
          agentNotStarted: (ticket.agentState ?? 'none') === 'not-started',
          // A RUNNING ship is the driver's own work, so the agent-waiting
          // banner must not outrank it (869ed7bpd). `needsUser` already
          // excludes that case — this is the rail's own guard, belt and
          // braces with the same exception.
          shipStatus: shipCell.status,
          shipReason: shipCell.reason,
          shipAwaitingMerge:
            stepper.find((c) => c.stageKey === 'ship')?.blocked?.kind === 'awaiting-merge',
          mergeGate,
          mergeableRepos,
        })
      : null,
    capFor: fixCapFor,
  });
}
