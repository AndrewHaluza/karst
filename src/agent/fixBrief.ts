import type { StageKey } from '../model/types.js';
import type { StepperStageRow } from '../model/stepper.js';

/** The deterministic gates whose failure is what a `fix` session must address. */
const GATES: readonly StageKey[] = ['uat', 'review'] as const;

/**
 * The opening prompt for a session resumed at `fix`. A bare "continue the work"
 * wastes the one thing karst knows and the agent does not: which gate failed, why
 * (the recorded verdict) and where the full output is. Returns null when no gate
 * is failed — there is nothing specific to fix, so the caller keeps its generic
 * resume line.
 *
 * Pure (no store, no fs) so the wording is unit-tested.
 */
export function renderFixBrief(
  ticketLabel: string,
  stages: readonly StepperStageRow[],
): string | null {
  const gate = stages.find((s) => GATES.includes(s.stageKey) && s.status === 'failed');
  if (!gate) return null;

  const lines = [
    `The ${gate.stageKey} gate failed for ticket ${ticketLabel}. Fix what it reported, ` +
      'then re-run the checks yourself to confirm they pass.',
  ];
  if (gate.verdict) lines.push('', `It reported: ${gate.verdict}`);
  if (gate.artifactPath) lines.push('', `Its full output is at ${gate.artifactPath} — read it first.`);
  return lines.join('\n');
}
