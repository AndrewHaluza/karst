import { describe, it, expect } from 'vitest';
import type { ProcessRun } from '../../store/processRuns.js';
import type { RecoveryRound } from '../../store/recoveryRounds.js';
import type { InsideProcessView } from './types.js';
import { insertCausalFix, recoveryProcess, type RecoveryProcessView } from './recovery.js';

const NOW = '2026-07-20T12:30:00.000Z';

let nextRound = 1;
function round(extra: Partial<RecoveryRound> = {}): RecoveryRound {
  return {
    id: nextRound++,
    ticketId: 1,
    sourceStage: 'uat',
    sourceProcessId: 'gates',
    sourceStageRunId: 10,
    sourceProcessRunId: null,
    triggerKind: 'gate-failure',
    triggerDetail: 'exit 1',
    episode: 1,
    round: 1,
    maxRounds: 2,
    fixProcessRunId: null,
    uatRevalidationStageRunId: null,
    reviewRevalidationStageRunId: null,
    status: 'pending',
    startedAt: '2026-07-20T12:00:00.000Z',
    endedAt: null,
    interruptCount: 0,
    ...extra,
  };
}

let nextRun = 1;
function fixRun(extra: Partial<ProcessRun> = {}): ProcessRun {
  return {
    id: nextRun++,
    ticketId: 1,
    stageKey: 'fix',
    processId: 'fix',
    attempt: 0,
    stageRunId: null,
    agentName: 'UAT Fix Agent',
    provider: 'codex',
    model: 'sol',
    pid: null,
    status: 'passed',
    resultKind: null,
    artifactPath: null,
    failureDetail: null,
    promptTelemetry: null,
    startedAt: '2026-07-20T12:05:00.000Z',
    endedAt: '2026-07-20T12:06:00.000Z',
    ...extra,
  };
}

function process(id: string): InsideProcessView {
  return { id, kind: id, label: id, status: 'pending' };
}

const base: readonly InsideProcessView[] = [
  process('gates'),
  process('services'),
  process('tester'),
];

describe('recoveryProcess', () => {
  it('returns null when the stage recorded no recovery round — a fix row needs evidence', () => {
    expect(recoveryProcess([], [], NOW)).toBeNull();
  });

  // A review-origin round can be left `failed` when its revalidation is
  // interrupted by an UNRELATED uat failure: openRecoveryRound fails the old
  // round and opens a new one attributed to uat, so the round series never
  // revisits review even though the driver goes on to re-run and pass it —
  // the exact ticket 380 sequence (round 79 `review`/failed, round 80
  // `uat`/passed) that left "Inside Review" reading Fix as failed forever.
  it('reads as passed once the owning stage itself currently reads passed, even with a terminal failed round', () => {
    const failedRound = round({ id: 1, sourceStage: 'review', status: 'failed' });
    const stillFailing = recoveryProcess([failedRound], [], NOW, undefined, false);
    expect(stillFailing!.process.status).toBe('fail');

    const view = recoveryProcess([failedRound], [], NOW, undefined, true);
    expect(view!.process.status).toBe('pass');
    expect(view!.process.detail).toBe(
      "Review passed on a later attempt — this round's own failure is history",
    );
  });

  it('names the LATEST round as the trigger process', () => {
    const view = recoveryProcess(
      [
        round({ id: 1, sourceProcessId: 'gates', triggerKind: 'gate-failure' }),
        round({ id: 2, sourceProcessId: 'tester', triggerKind: 'tester-verifier-failure' }),
      ],
      [],
      NOW,
    );
    expect(view!.triggerProcessId).toBe('tester');
  });

  it('reports only the newest round: no evidence block, no round list', () => {
    const view = recoveryProcess(
      [
        round({ id: 1, round: 1, triggerDetail: 'exit 1', status: 'failed' }),
        round({ id: 2, round: 2, maxRounds: 3, status: 'fixing' }),
      ],
      [],
      NOW,
    )!;
    expect(view.process.evidence).toBeUndefined();
    expect(view.process.status).toBe('run');
    // handoff §11: the cause is the recorded trigger KIND.
    expect(view.process.detail).toBe('Fix started after UAT test failure');
  });

  it('states every recovery state in the handoff §11 copy (B9)', () => {
    const fixing = recoveryProcess([round({ status: 'fixing' })], [], NOW)!;
    expect(fixing.process.detail).toBe('Fix started after UAT test failure');
    const revalidating = recoveryProcess([round({ status: 'revalidating' })], [], NOW)!;
    expect(revalidating.process.detail).toBe('Fix completed; UAT revalidation is running');
    const exhausted = recoveryProcess([round({ status: 'exhausted' })], [], NOW)!;
    expect(exhausted.process.detail).toBe(
      'Recovery exhausted after 2 rounds. Resolve the remaining failure manually.',
    );
    // §3.8: the process row is silent until exhausted/failed — the running
    // and waiting copy must ride the collapsed row too.
    expect(recoveryProcess([round({ status: 'pending' })], [], NOW)!.process.detail).toBe(
      'Fix started after UAT test failure',
    );
    expect(recoveryProcess([round({ status: 'revalidating' })], [], NOW)!.process.detail).toBe(
      'Fix completed; UAT revalidation is running',
    );
    expect(exhausted.process.detail).toBe(
      'Recovery exhausted after 2 rounds. Resolve the remaining failure manually.',
    );
  });

  it('names an interrupted round on the COLLAPSED fix row — never silent', () => {
    // The fix session died without the marker (the interrupted status is a
    // crash, not a verdict): the collapsed row must say so and name that the
    // round can be resumed, never render silent.
    const interrupted = recoveryProcess([round({ status: 'interrupted' })], [], NOW)!;
    expect(interrupted.process.status).toBe('note');
    expect(interrupted.process.detail).toBe(
      'the fix session ended before it was done — it can be resumed',
    );
  });

  it('names each trigger kind in prose (B9)', () => {
    const gate = recoveryProcess([round({ sourceStage: 'review', triggerKind: 'gate-failure' })], [], NOW)!;
    expect(gate.process.detail).toBe('Fix started after Review test failure');
    const verifier = recoveryProcess([round({ triggerKind: 'tester-verifier-failure' })], [], NOW)!;
    expect(verifier.process.detail).toBe('Fix started after UAT verifier failure');
    const findings = recoveryProcess([round({ triggerKind: 'blocking-review-findings' })], [], NOW)!;
    expect(findings.process.detail).toBe('Fix started after Review blocking findings');
    // The UAT twin of the review findings round (Task 3.2). Without its own
    // case it falls to the `default` and the Inside block renders the raw
    // machine string ("uat tester observations: 1 high") where its twin
    // renders curated prose.
    const observations = recoveryProcess(
      [
        round({
          triggerKind: 'blocking-tester-observations',
          triggerDetail: 'uat tester observations: 1 high',
        }),
      ],
      [],
      NOW,
    )!;
    expect(observations.process.detail).toBe(
      'Fix started after UAT blocking observations',
    );
    // D159: a dismissed usage-limit park opens a recovery round whose trigger
    // names the dismissal in curated prose, not the raw machine detail.
    const dismissed = recoveryProcess(
      [
        round({
          triggerKind: 'usage-limit-dismissed',
          triggerDetail: 'Monthly quota exceeded',
        }),
      ],
      [],
      NOW,
    )!;
    expect(dismissed.process.detail).toBe(
      'Fix started after Usage limit dismissed',
    );
  });

  it('maps round states onto the process status vocabulary', () => {
    const pending = recoveryProcess([round({ status: 'pending' })], [], NOW)!;
    expect(pending.process.status).toBe('run');
    const fixing = recoveryProcess([round({ status: 'fixing' })], [], NOW)!;
    expect(fixing.process.status).toBe('run');
    // `revalidating` means the FIX itself finished — the ticket is back at the
    // gate and the gate row reports that re-run. A spinner here claimed the fix
    // was still working long after it had handed the ticket back, on the very
    // attempt whose fix had already completed.
    const revalidating = recoveryProcess([round({ status: 'revalidating' })], [], NOW)!;
    expect(revalidating.process.status).toBe('pass');
    const passed = recoveryProcess([round({ status: 'passed' })], [], NOW)!;
    expect(passed.process.status).toBe('pass');
    const failed = recoveryProcess([round({ status: 'failed' })], [], NOW)!;
    expect(failed.process.status).toBe('fail');
    const exhausted = recoveryProcess([round({ status: 'exhausted' })], [], NOW)!;
    expect(exhausted.process.status).toBe('fail');
    const interrupted = recoveryProcess([round({ status: 'interrupted' })], [], NOW)!;
    expect(interrupted.process.status).toBe('note');
  });

  it('states exhaustion on the row and the process, once — never a second fix row', () => {
    const view = recoveryProcess(
      [round({ id: 1, round: 1, status: 'failed' }), round({ id: 2, round: 2, status: 'exhausted' })],
      [],
      NOW,
    );
    expect(view!.process.evidence).toBeUndefined();
    expect(view!.process.detail).toBe(
      'Recovery exhausted after 2 rounds. Resolve the remaining failure manually.',
    );
  });

  it('carries the fix execution identity and duration when a fix run is attached', () => {
    const run = fixRun({ id: 7, startedAt: '2026-07-20T12:05:00.000Z', endedAt: '2026-07-20T12:05:30.000Z' });
    const view = recoveryProcess([round({ fixProcessRunId: 7 })], [run], NOW)!;
    expect(view.process.duration).toBe('30.0s');
    expect(view.process.execution).toMatchObject({ provider: 'codex', model: 'sol' });
  });

  it('shows the fix execution identity the round recorded', () => {
    const run = fixRun({ id: 7 });
    const view = recoveryProcess([round({ fixProcessRunId: 7 })], [run], NOW)!;
    expect(view.process.execution).toMatchObject({
      provider: 'codex',
      model: 'sol',
      agentName: 'UAT Fix Agent',
    });
    expect(view.process.configuredExecution).toBeUndefined();
    expect(view.process.identityNote).toBeUndefined();
  });

  it('falls back to the configured identity when no fix run was recorded', () => {
    const view = recoveryProcess([round()], [], NOW, { provider: 'claude', model: 'opus' })!;
    expect(view.process.configuredExecution).toMatchObject({ provider: 'claude', model: 'opus' });
    expect(view.process.execution).toBeUndefined();
    expect(view.process.identityNote).toBeUndefined();
  });

  it('states identity absence for a fix run that recorded no provider', () => {
    const run = fixRun({ id: 7, provider: null, model: null, agentName: null });
    const view = recoveryProcess(
      [round({ fixProcessRunId: 7 })],
      [run],
      NOW,
      { provider: 'claude', model: 'opus' },
    )!;
    expect(view.process.identityNote).toBe('No historical execution identity recorded');
    expect(view.process.execution).toBeUndefined();
    expect(view.process.configuredExecution).toBeUndefined();
  });

});

describe('insertCausalFix', () => {
  it('returns the processes unchanged when recovery is null — no fix without evidence', () => {
    expect(insertCausalFix(base, null)).toEqual(base);
    expect(insertCausalFix(base, null)).not.toBe(base);
  });

  it('inserts the fix process immediately after its trigger process', () => {
    const recovery = recoveryProcess([round()], [], NOW)!;
    expect(insertCausalFix(base, recovery).map((p) => p.id)).toEqual([
      'gates',
      'fix',
      'services',
      'tester',
    ]);
  });

  it('appends at the end when the trigger process is not among the processes', () => {
    const recovery = recoveryProcess([round({ sourceProcessId: 'review' })], [], NOW)!;
    expect(insertCausalFix(base, recovery).map((p) => p.id)).toEqual([
      'gates',
      'services',
      'tester',
      'fix',
    ]);
  });

  it('keeps the trigger process row itself before the inserted fix', () => {
    const processes: readonly InsideProcessView[] = [process('gates'), process('services'), process('review')];
    const recovery = recoveryProcess([round({ sourceProcessId: 'review' })], [], NOW)!;
    expect(insertCausalFix(processes, recovery).map((p) => p.id)).toEqual([
      'gates',
      'services',
      'review',
      'fix',
    ]);
  });
});

describe('recoveryProcess — stored fix brief receipt (@arch:V77)', () => {
  const facts = {
    id: 12,
    pointedAt: 't',
    repointedAt: null,
    pointerFailedAt: null,
    readAt: null,
    deliveredVia: null,
    supersededAt: null,
  };

  it('appends the receipt state to the Fix row', () => {
    const view = recoveryProcess([{ ...round(), fixDelivery: facts }], [], NOW)!;
    expect(view.process.detail).toMatch(/ · fix brief #12 pointed at, not read yet$/);
  });

  it('leaves a round without a delivery unchanged', () => {
    const view = recoveryProcess([round()], [], NOW)!;
    expect(view.process.detail).not.toContain('fix brief');
  });
});
