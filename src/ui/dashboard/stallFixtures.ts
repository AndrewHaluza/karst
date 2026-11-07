import type { DashboardState } from './state.js';
import { populatedStateFor } from './renderFixtures.js';

/** The states of the stall panel a fixture can show (T1001). */
export type StallFixtureKind = 'generating' | 'several' | 'one' | 'failed';

const AT = '2026-08-12T10:00:00.000Z';

const OPTIONS = [
  { kind: 'agent' as const, label: 'Cut the scope', note: 'Remove the extra part.', description: 'A smaller description.', acceptanceCheck: 'A smaller check.', recommended: true },
  { kind: 'agent' as const, label: 'Split the ticket', note: 'Do the first half only.', recommended: false },
  { kind: 'agent' as const, label: 'Relax the check', note: 'Judge the main path only.', acceptanceCheck: 'The main path works.', recommended: false },
];

/** A fix-stage ticket parked on a review stall with a suggestion in one state. Fixed data: no clock. */
export function stallFixtureState(kind: StallFixtureKind): DashboardState {
  const s = populatedStateFor('uat');
  const cell = s.stepper.find((c) => c.stageKey === 'uat')!;
  const ready = kind === 'several' || kind === 'one';
  return {
    ...s,
    currentStage: { ...cell, blocked: { kind: 'review-stalled', reason: 'The same files failed review again.', at: AT, resumable: false } },
    stall: {
      parkAt: AT,
      status: kind === 'several' || kind === 'one' ? 'ready' : kind,
      rounds: [
        { attempt: 0, runAt: '2026-08-12T08:00:00.000Z', findings: [
          { severity: 'critical', file: 'src/a.ts', line: 3, title: 'The split loses a case' },
          { severity: 'medium', file: 'src/b.ts', line: 9, title: 'A name hides intent' },
        ] },
        { attempt: 1, runAt: '2026-08-12T09:00:00.000Z', findings: [{ severity: 'high', file: 'src/a.ts', line: 3, title: 'The split still loses a case' }] },
      ],
      diff: { fileCount: 2, stat: ' src/a.ts | 12 +++---\n src/b.ts | 4 +-' },
      current: { description: 'The full description.', acceptanceCheck: 'The full check.' },
      ...(ready ? { cause: 'The scope is likely too wide for one round.', options: kind === 'one' ? OPTIONS.slice(0, 1) : OPTIONS } : { options: [] }),
      ...(kind === 'failed' ? { error: 'The agent call failed.' } : {}),
    },
  } as DashboardState;
}
