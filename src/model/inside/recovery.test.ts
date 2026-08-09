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
    round: 1,
    maxRounds: 2,
    fixProcessRunId: null,
    uatRevalidationStageRunId: null,
    reviewRevalidationStageRunId: null,
    status: 'pending',
    startedAt: '2026-07-20T12:00:00.000Z',
    endedAt: null,
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

function evidenceRows(recovery: RecoveryProcessView): readonly { status: string; label: string; detail: string }[] {
  const evidence = recovery.process.evidence;
  if (evidence?.kind !== 'recovery') throw new Error('expected recovery evidence');
  return evidence.rows as readonly { status: string; label: string; detail: string }[];
}

describe('recoveryProcess', () => {
  it('returns null when the stage recorded no recovery round — a fix row needs evidence', () => {
    expect(recoveryProcess([], [], NOW)).toBeNull();
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

  it('renders one recovery row per round, oldest first, cause and STORED budget', () => {
    const view = recoveryProcess(
      [round({ id: 1, round: 1, triggerDetail: 'exit 1' }), round({ id: 2, round: 2, maxRounds: 3 })],
      [],
      NOW,
    );
    const rows = evidenceRows(view!);
    expect(rows.map((r) => r.label)).toEqual(['round 1', 'round 2']);
    expect(rows[0]!.detail).toContain('exit 1');
    expect(rows[0]!.detail).toContain('max 2');
    // Stored max stability: the budget rendered comes from the ROW, and the
    // reducer has no manifest to consult — a knob edited after the failure
    // cannot rewrite what the round committed under.
    expect(rows[1]!.detail).toContain('max 3');
  });

  it('maps round states onto the process status vocabulary', () => {
    const pending = recoveryProcess([round({ status: 'pending' })], [], NOW)!;
    expect(pending.process.status).toBe('run');
    const fixing = recoveryProcess([round({ status: 'fixing' })], [], NOW)!;
    expect(fixing.process.status).toBe('run');
    const revalidating = recoveryProcess([round({ status: 'revalidating' })], [], NOW)!;
    expect(revalidating.process.status).toBe('wait');
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
    const rows = evidenceRows(view!);
    expect(rows.map((r) => r.label)).toEqual(['round 1', 'round 2']);
    expect(rows[1]!.detail).toContain('no fix attempts left');
    expect(view!.process.detail).toBe('no fix attempts left');
  });

  it('carries the fix execution identity and duration when a fix run is attached', () => {
    const run = fixRun({ id: 7, startedAt: '2026-07-20T12:05:00.000Z', endedAt: '2026-07-20T12:05:30.000Z' });
    const view = recoveryProcess([round({ fixProcessRunId: 7 })], [run], NOW)!;
    expect(view.process.duration).toBe('30.0s');
    expect(view.process.execution).toMatchObject({ provider: 'codex', model: 'sol' });
  });

  it('bounds the round history and names the remainder', () => {
    const many = Array.from({ length: 10 }, (_, i) => round({ id: i + 1, round: i + 1 }));
    const rows = evidenceRows(recoveryProcess(many, [], NOW)!);
    expect(rows).toHaveLength(9);
    expect(rows.at(-1)).toMatchObject({ status: 'note', label: 'more' });
    expect(rows.at(-1)!.detail).toContain('2');
  });

  it('collapses a multi-line trigger detail before it reaches a row', () => {
    const view = recoveryProcess([round({ triggerDetail: 'line one\nline two' })], [], NOW)!;
    const rows = evidenceRows(view);
    expect(rows[0]!.detail).not.toContain('\n');
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
