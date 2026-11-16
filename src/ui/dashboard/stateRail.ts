import { buildStageRail } from '../../model/stageRail.js';
import type { ImplSessionReading } from '../../model/implSessionReading.js';
import { gatedRailNeeds } from '../../model/railNeeds.js';
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
  implSession?: ImplSessionReading | null;
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
  implSession,
}: RailInput) {
  const needs = gatedRailNeeds({
    stageCurrent: ticket.stageCurrent,
    agentState: ticket.agentState,
    blocked,
    currentCell: currentStage,
    shipCell: cellOf('ship'),
    mergeGate,
    mergeableRepos,
  });
  return buildStageRail(stepper, ticket.stages, {
    current: ticket.stageCurrent,
    needsUser: blocked || needs !== null,
    needs,
    capFor: fixCapFor,
    implSession,
  });
}
