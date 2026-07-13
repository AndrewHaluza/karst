import { STAGE_KEYS, type StageKey, type StageStatus } from './types.js';

/**
 * One stepper cell — a stage node in a workflow stepper (§14). Shared by the
 * dashboard (live, per-server view) and the onboarding edit page (read-only
 * progress glance) so both order and shape stay identical.
 */
export interface StepperCell {
  stageKey: StageKey;
  status: StageStatus;
}

/**
 * Project a ticket's stage rows onto the canonical, stable stepper order
 * (`STAGE_KEYS`, not stage-row insertion order). A stage with no row yet reads
 * as `pending` — the pre-run default — so the stepper is complete on every
 * ticket regardless of how many stages have actually started.
 */
export function buildStepper(
  stages: readonly { stageKey: StageKey; status: StageStatus }[],
): StepperCell[] {
  const byKey = new Map(stages.map((s) => [s.stageKey, s]));
  return STAGE_KEYS.map((stageKey) => ({
    stageKey,
    status: byKey.get(stageKey)?.status ?? 'pending',
  }));
}
