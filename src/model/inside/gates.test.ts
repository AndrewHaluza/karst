import { describe, it, expect } from 'vitest';
import type { GateRun } from '../../store/gateRuns.js';
import type { ProcessRun } from '../../store/processRuns.js';
import type { RecoveryRound } from '../../store/recoveryRounds.js';
import type { Finding } from '../../store/reviewFindings.js';
import type { UatFinding } from '../../store/uatFindings.js';
import type { Severity } from '../../manifest/types.js';
import type { StepperCell } from '../stepper.js';
import type { StageKey, StageStatus } from '../types.js';
import { reviewInside, uatInside, reviewProcesses, uatProcesses, type QualityProcessesInput } from './gates.js';
import type { EvidenceRow, InsideProcessView } from './types.js';

const NOW = '2026-07-20T12:30:00.000Z';

function cell(stageKey: StageKey, status: StageStatus, extra: Partial<StepperCell> = {}): StepperCell {
  return { stageKey, status, ...extra };
}

let nextId = 1;
function run(
  stageKey: StageKey,
  gateName: string,
  exitCode: number | null,
  extra: Partial<GateRun> = {},
): GateRun {
  return {
    id: nextId++,
    ticketId: 1,
    stageKey,
    attempt: 0,
    stageRunId: null,
    runAt: '2026-07-20T12:00:00.000Z',
    gateName,
    exitCode,
    startedAt: null,
    endedAt: null,
    repo: null,
    command: null,
    args: null,
    skipped: false,
    ...extra,
  };
}

let nextFindingId = 1;
function finding(severity: Severity, extra: Partial<Finding> = {}): Finding {
  return {
    id: nextFindingId++,
    ticketId: 1,
    attempt: 0,
    runAt: '2026-07-20T12:00:00.000Z',
    processRunId: null,
    severity,
    repo: '/web',
    file: null,
    line: null,
    title: 'x',
    detail: 'y',
    source: 'agent',
    createdAt: '2026-07-20T12:00:00.000Z',
    ...extra,
  };
}

let nextRunId = 1;
function processRun(extra: Partial<ProcessRun> = {}): ProcessRun {
  return {
    id: nextRunId++,
    ticketId: 1,
    stageKey: 'uat',
    processId: 'tester',
    attempt: 0,
    stageRunId: null,
    agentName: 'UAT Agent',
    provider: 'codex',
    model: 'sol',
    pid: null,
    status: 'passed',
    resultKind: 'observed',
    artifactPath: null,
    startedAt: '2026-07-20T12:00:00.000Z',
    endedAt: '2026-07-20T12:01:00.000Z',
    ...extra,
  };
}

let nextRoundId = 1;
function round(extra: Partial<RecoveryRound> = {}): RecoveryRound {
  return {
    id: nextRoundId++,
    ticketId: 1,
    sourceStage: 'uat',
    sourceProcessId: 'gates',
    sourceStageRunId: null,
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

let nextUatFindingId = 1;
function uatFinding(severity: Severity, extra: Partial<UatFinding> = {}): UatFinding {
  return {
    id: nextUatFindingId++,
    ticketId: 1,
    processRunId: 1,
    repo: '/web',
    severity,
    title: 'x',
    filePath: null,
    line: null,
    createdAt: '2026-07-20T12:00:00.000Z',
    ...extra,
  };
}

function qualityInput(extra: Partial<QualityProcessesInput> = {}): QualityProcessesInput {
  return {
    cell: cell('uat', 'passed', {
      startedAt: '2026-07-20T12:00:00.000Z',
      endedAt: '2026-07-20T12:02:00.000Z',
    }),
    gateRuns: [],
    findings: [],
    uatFindings: [],
    processRuns: [],
    rounds: [],
    services: ['web', 'api'],
    now: NOW,
    ...extra,
  };
}

function rowsOf(process: InsideProcessView): readonly EvidenceRow[] {
  const evidence = process.evidence;
  if (evidence?.kind === 'rows') return evidence.rows;
  if (evidence?.kind === 'gates') return evidence.rows;
  if (evidence?.kind === 'findings') return evidence.rows;
  if (evidence?.kind === 'recovery') return evidence.rows;
  throw new Error(`expected rows-bearing evidence, got ${process.evidence?.kind ?? 'none'}`);
}

describe('reviewInside', () => {
  // Review resolves its gates from the repository's package.json at RUNTIME,
  // per target, so the recorded rows ARE the list. Matching them against a
  // static constant showed every gate as pending forever once the names started
  // carrying their repository label — the same trap `uatInside` documents.
  it('lists every recorded gate, whatever it was named', () => {
    const runs = [
      run('review', 'lint (web)', 0),
      run('review', 'typecheck (web)', 0),
      run('review', 'test (api)', 0),
    ];
    const ops = reviewInside(cell('review', 'passed'), runs, [], NOW).ops;
    expect(ops.map((o) => o.name)).toEqual(['lint (web)', 'typecheck (web)', 'test (api)']);
  });

  it('reads a failing gate as failed, naming the exit code', () => {
    const ops = reviewInside(cell('review', 'failed'), [run('review', 'lint (web)', 1)], [], NOW).ops;
    const lint = ops.find((o) => o.name === 'lint (web)')!;
    expect(lint.status).toBe('fail');
    expect(lint.detail).toContain('exit 1');
  });

  it('never reads a gate the repo cannot answer as a pass', () => {
    // exitCode null means there was no script to run. Showing it green would
    // claim a check karst never made.
    const ops = reviewInside(cell('review', 'passed'), [run('review', 'lint (web)', null)], [], NOW).ops;
    const lint = ops.find((o) => o.name === 'lint (web)')!;
    expect(lint.status).toBe('note');
    expect(lint.status).not.toBe('pass');
    expect(lint.detail).toContain('nothing to run');
  });

  it('renders only the latest batch when a gate has been run more than once', () => {
    const first = run('review', 'lint (web)', 1, { runAt: '2026-07-20T12:00:00.000Z' });
    const second = run('review', 'lint (web)', 0, { runAt: '2026-07-20T12:20:00.000Z' });
    const ops = reviewInside(cell('review', 'passed'), [first, second], [], NOW).ops;
    expect(ops).toHaveLength(1);
    expect(ops[0]!.status).toBe('pass');
  });

  it('picks the latest batch by its stamp, not by where it sits in the array', () => {
    // Otherwise this silently depends on the store returning rows in insertion
    // order, which no query contract guarantees — an added index or a planner
    // change would surface a stale run with nothing failing to say so.
    const older = run('review', 'lint (web)', 1, { runAt: '2026-07-20T12:00:00.000Z' });
    const newer = run('review', 'lint (web)', 0, { runAt: '2026-07-20T12:20:00.000Z' });
    const ops = reviewInside(cell('review', 'passed'), [newer, older], [], NOW).ops;
    expect(ops[0]!.status).toBe('pass');
  });

  it('states the changes surface as still to come while the gate runs, and as opened once a real openDiff recorded it', () => {
    const running = reviewInside(cell('review', 'running'), [], [], NOW).ops;
    expect(running.at(-1)).toMatchObject({ name: 'changes', status: 'note' });

    const done = reviewInside(
      cell('review', 'failed'),
      [run('review', 'lint (web)', 1), run('review', 'changes', 0)],
      [],
      NOW,
    ).ops;
    // review opens the changes surface on both verdicts, so this is observed,
    // not inferred. Named 'changes': the host reveals the Changes panel, not
    // a diff editor (that is one click further, inside the panel).
    expect(done.at(-1)).toMatchObject({ name: 'changes', status: 'pass' });
  });

  it('never lists the changes row among the gates that decided the verdict', () => {
    // It is evidence recorded in the same batch, but it is not a gate and it
    // never touched the verdict — showing it twice would say it did.
    const ops = reviewInside(
      cell('review', 'passed'),
      [run('review', 'lint (web)', 0), run('review', 'changes', 0)],
      [],
      NOW,
    ).ops;
    expect(ops.filter((o) => o.name === 'changes')).toHaveLength(1);
    expect(ops[0]!.name).toBe('lint (web)');
  });

  it('emits no changes row when nothing opened it', () => {
    // A finished stage with real gate evidence but no recorded 'changes' run
    // means no `openDiff` was wired for that run (e.g. no host supplied one).
    // The row must say nothing, never claim a control nobody performed.
    const done = reviewInside(cell('review', 'passed'), [run('review', 'lint (web)', 0)], [], NOW).ops;
    expect(done.find((o) => o.name === 'changes')).toBeUndefined();

    const failed = reviewInside(cell('review', 'failed'), [run('review', 'lint (web)', 1)], [], NOW).ops;
    expect(failed.find((o) => o.name === 'changes')).toBeUndefined();
  });

  it('names no changes row before the stage has run — nothing opened or promised yet', () => {
    const ops = reviewInside(cell('review', 'pending'), [], [], NOW).ops;
    expect(ops.find((o) => o.name === 'changes')).toBeUndefined();
  });

  it('shows a gate duration when the run recorded one', () => {
    const runs = [
      run('review', 'lint (web)', 0, {
        startedAt: '2026-07-20T12:00:00.000Z',
        endedAt: '2026-07-20T12:00:06.400Z',
      }),
    ];
    const ops = reviewInside(cell('review', 'passed'), runs, [], NOW).ops;
    expect(ops.find((o) => o.name === 'lint (web)')!.duration).toBe('6.4s');
  });

  it('says the gates are not known yet before the stage has run', () => {
    // Review cannot name its gates before it probes a repository for them, so
    // it says that rather than promising a list it may not run.
    const strip = reviewInside(cell('review', 'pending'), [], [], NOW);
    expect(strip.ops).toEqual([
      { status: 'pending', name: 'gates', detail: 'resolved per repository when the stage runs', duration: '' },
    ]);
    expect(strip.blurb).not.toBe('');
    expect(strip.clock).toBe('has not run yet');
  });

  it('shows nothing for a finished stage that recorded no gates', () => {
    // A finished stage with no rows predates this record; inventing one would be
    // a guess, and a pending row on a passed stage would be a false promise.
    expect(reviewInside(cell('review', 'passed'), [], [], NOW).ops).toEqual([]);
  });

  it('ignores gate rows belonging to another stage', () => {
    // A uat failure is not review evidence. With nothing of its own recorded,
    // review has nothing to show — not a borrowed red row.
    const ops = reviewInside(cell('review', 'passed'), [run('uat', 'test (web)', 1)], [], NOW).ops;
    expect(ops).toEqual([]);
  });

  it('renders a fail-styled row naming why a blocked stage could not ask its question', () => {
    const blockedCell = cell('review', 'running', {
      blocked: { kind: 'nothing-to-run', reason: 'no target resolved', at: NOW },
    });
    const ops = reviewInside(blockedCell, [], [], NOW).ops;
    expect(ops).toEqual([
      { status: 'fail', name: 'blocked', detail: 'no target resolved', duration: '' },
    ]);
  });

  it('keeps whatever gate evidence ran before the block, alongside the block row', () => {
    const blockedCell = cell('review', 'running', {
      blocked: { kind: 'capability-missing', reason: 'api: cannot read package.json', at: NOW },
    });
    const ops = reviewInside(blockedCell, [run('review', 'lint (web)', 0)], [], NOW).ops;
    expect(ops.map((o) => o.name)).toEqual(['lint (web)', 'blocked']);
    expect(ops.at(-1)).toMatchObject({
      status: 'fail',
      detail: 'api: cannot read package.json',
    });
  });

  it('says nothing else is unresolved once a block already explains why', () => {
    // Without a block, an empty batch on a running/pending stage shows the
    // "resolved per repository" filler — but once a block exists, THAT is the
    // reason nothing ran, and doubling it with the generic filler would confuse
    // rather than inform.
    const blockedCell = cell('review', 'running', {
      blocked: { kind: 'nothing-to-run', reason: 'no target resolved', at: NOW },
    });
    const ops = reviewInside(blockedCell, [], [], NOW).ops;
    expect(ops.find((o) => o.name === 'gates')).toBeUndefined();
  });

  // I2 (spec §6.6): findings must be visible in `reviewInside`, not just the
  // fix brief and `karst context`. A user whose ticket just failed review
  // must be able to see what the finding actually said.
  describe('findings', () => {
    it('appends a row per finding from the latest batch, after the gate rows', () => {
      const ops = reviewInside(
        cell('review', 'failed'),
        [run('review', 'lint (web)', 0)],
        [finding('high', { title: 'missing null check' })],
        NOW,
      ).ops;
      expect(ops.map((o) => o.name)).toEqual(['lint (web)', 'high']);
      expect(ops[1]!.detail).toContain('missing null check');
    });

    it('renders a location when the finding is file-scoped', () => {
      const ops = reviewInside(
        cell('review', 'failed'),
        [],
        [finding('high', { title: 'oops', file: 'src/foo.ts', line: 42 })],
        NOW,
      ).ops;
      expect(ops[0]!.detail).toContain('src/foo.ts:42');
    });

    it('renders a whole-file location with no line when line is null', () => {
      const ops = reviewInside(
        cell('review', 'failed'),
        [],
        [finding('high', { title: 'oops', file: 'src/foo.ts', line: null })],
        NOW,
      ).ops;
      expect(ops[0]!.detail).toContain('src/foo.ts');
      expect(ops[0]!.detail).not.toContain('src/foo.ts:');
    });

    // Blocking severities read as fail-styled — they can be the reason the
    // ticket failed — while sub-threshold severities are informational.
    it('maps critical/high to fail and medium/low/info to note', () => {
      const ops = reviewInside(
        cell('review', 'failed'),
        [],
        [
          finding('critical'),
          finding('high'),
          finding('medium'),
          finding('low'),
          finding('info'),
        ],
        NOW,
      ).ops;
      expect(ops.map((o) => o.status)).toEqual(['fail', 'fail', 'note', 'note', 'note']);
    });

    it('shows only the latest batch, so a superseded attempt does not double the list', () => {
      const ops = reviewInside(
        cell('review', 'failed'),
        [],
        [
          finding('high', { runAt: '2026-07-20T11:00:00.000Z', title: 'stale' }),
          finding('low', { runAt: '2026-07-20T12:00:00.000Z', title: 'fresh' }),
        ],
        NOW,
      ).ops;
      expect(ops).toHaveLength(1);
      expect(ops[0]!.detail).toContain('fresh');
    });

    it('shows nothing when the latest batch found nothing', () => {
      const ops = reviewInside(cell('review', 'passed'), [run('review', 'lint (web)', 0)], [], NOW).ops;
      expect(ops.map((o) => o.name)).toEqual(['lint (web)']);
    });

    // A block already states why nothing ran; a stale prior-attempt finding
    // rendered alongside it would look like fresh evidence about a run that
    // never happened.
    it('suppresses findings entirely while the stage is blocked', () => {
      const blockedCell = cell('review', 'running', {
        blocked: { kind: 'nothing-to-run', reason: 'no target resolved', at: NOW },
      });
      const ops = reviewInside(blockedCell, [], [finding('critical')], NOW).ops;
      expect(ops.find((o) => o.name === 'critical')).toBeUndefined();
    });

    // Untrusted agent text: collapsed to one line and capped, exactly like
    // every other model-authored string reaching a rendered surface —
    // defense-in-depth even though `parseFindings` already collapsed it once
    // at the write-time boundary.
    it('collapses a multi-line or oversized title before it reaches the row', () => {
      const ops = reviewInside(
        cell('review', 'failed'),
        [],
        [finding('high', { title: 'line one\nline two\n\ttabbed' })],
        NOW,
      ).ops;
      expect(ops[0]!.detail).not.toContain('\n');
      expect(ops[0]!.detail).not.toContain('\t');
    });
  });
});

describe('uatInside', () => {
  it('reads a green gate as a pass', () => {
    const ops = uatInside(cell('uat', 'passed'), [run('uat', 'test (web)', 0)], NOW).ops;
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ name: 'test (web)', status: 'pass' });
    expect(ops[0]!.detail).toContain('exit 0');
  });

  // UAT's gate set is per-repository and resolved at runtime, so the recorded
  // rows ARE the list. Matching them against a static constant showed every gate
  // as pending once the names started carrying their repository label.
  it('lists every recorded gate, whatever it was named', () => {
    const ops = uatInside(
      cell('uat', 'passed'),
      [run('uat', 'test (web)', 0), run('uat', 'e2e (web)', 0), run('uat', 'test (api)', 0)],
      NOW,
    ).ops;
    expect(ops.map((o) => o.name)).toEqual(['test (web)', 'e2e (web)', 'test (api)']);
  });

  it('reads a gate that never ran as a note, even though the stage passed', () => {
    // uat is not failed by a gate it could not ask, but the row must not claim a
    // green suite — there was no suite.
    const strip = uatInside(cell('uat', 'passed'), [run('uat', 'test (web)', null)], NOW);
    expect(strip.ops[0]!.status).toBe('note');
    expect(strip.ops[0]!.detail).toContain('nothing to run');
  });

  it('reads a failing gate as failed', () => {
    const ops = uatInside(cell('uat', 'failed'), [run('uat', 'test (web)', 3)], NOW).ops;
    expect(ops[0]).toMatchObject({ name: 'test (web)', status: 'fail' });
    expect(ops[0]!.detail).toContain('exit 3');
  });

  it('renders a skipped gate as skip, worded as a user decision', () => {
    const ops = uatInside(
      cell('uat', 'passed'),
      [run('uat', 'e2e', null, { skipped: true })],
      NOW,
    ).ops;
    expect(ops).toEqual([
      { status: 'skip', name: 'e2e', detail: 'Skipped — disabled by user', duration: '' },
    ]);
  });

  it('keeps a missing-script row as a note, distinct from a skip', () => {
    const ops = uatInside(
      cell('uat', 'passed'),
      [run('uat', 'e2e', null, { skipped: false })],
      NOW,
    ).ops;
    expect(ops[0]).toEqual({ status: 'note', name: 'e2e', detail: 'nothing to run', duration: '' });
  });

  it('shows only the latest batch, so a prior attempt does not double the list', () => {
    const ops = uatInside(
      cell('uat', 'failed'),
      [
        run('uat', 'test (web)', 1, { runAt: '2026-07-20T11:00:00.000Z' }),
        run('uat', 'test (web)', 0, { runAt: '2026-07-20T12:00:00.000Z' }),
      ],
      NOW,
    ).ops;
    expect(ops).toHaveLength(1);
    expect(ops[0]!.status).toBe('pass');
  });

  it('says the gates are not known yet while the stage is still running', () => {
    // No row has been written, and UAT cannot name its gates before it resolves
    // them — so it says that rather than showing an empty strip.
    expect(uatInside(cell('uat', 'running'), [], NOW).ops).toEqual([
      { status: 'pending', name: 'gates', detail: 'resolved per repository when the stage runs', duration: '' },
    ]);
  });

  it('says the same before the stage has run', () => {
    expect(uatInside(cell('uat', 'pending'), [], NOW).ops).toEqual([
      { status: 'pending', name: 'gates', detail: 'resolved per repository when the stage runs', duration: '' },
    ]);
  });

  it('shows nothing for a finished stage that recorded no gates', () => {
    // A finished stage with no rows predates this record; inventing one would be
    // a guess, and a pending row on a passed stage would be a false promise.
    expect(uatInside(cell('uat', 'passed'), [], NOW).ops).toEqual([]);
  });

  it("ignores another stage's rows", () => {
    expect(uatInside(cell('uat', 'passed'), [run('review', 'lint', 0)], NOW).ops).toEqual([]);
  });
});

describe('uatProcesses', () => {
  it('emits gates, services, tester in registry order when nothing triggered recovery', () => {
    const views = uatProcesses(qualityInput());
    expect(views.map((p) => p.id)).toEqual(['gates', 'services', 'tester']);
  });

  it('inserts the fix process immediately after gates for a gate-triggered round', () => {
    const views = uatProcesses(qualityInput({ rounds: [round()] }));
    expect(views.map((p) => p.id)).toEqual(['gates', 'fix', 'services', 'tester']);
  });

  it('inserts the fix process after the tester process for a verifier-triggered round', () => {
    const views = uatProcesses(
      qualityInput({
        rounds: [round({ sourceProcessId: 'tester', triggerKind: 'tester-verifier-failure' })],
      }),
    );
    expect(views.map((p) => p.id)).toEqual(['gates', 'services', 'tester', 'fix']);
  });

  it('creates no fix process without recovery evidence, whatever the gate verdict', () => {
    const views = uatProcesses(
      qualityInput({ gateRuns: [run('uat', 'test (web)', 1, { runAt: NOW })] }),
    );
    expect(views.map((p) => p.id)).toEqual(['gates', 'services', 'tester']);
  });

  it('counts gate outcomes and keeps skip and note distinct from pass and fail', () => {
    const views = uatProcesses(
      qualityInput({
        gateRuns: [
          run('uat', 'test (web)', 0, { runAt: NOW }),
          run('uat', 'e2e (web)', 3, { runAt: NOW }),
          run('uat', 'lint (web)', null, { runAt: NOW, skipped: true }),
          run('uat', 'typecheck (web)', null, { runAt: NOW }),
        ],
      }),
    );
    const gates = views[0]!;
    expect(gates.status).toBe('fail');
    const evidence = gates.evidence as { kind: 'gates'; rows: readonly EvidenceRow[]; passed: number; failed: number; skipped: number };
    expect(evidence.passed).toBe(1);
    expect(evidence.failed).toBe(1);
    expect(evidence.skipped).toBe(1);
    expect(evidence.rows.map((r) => r.status)).toEqual(['pass', 'fail', 'skip', 'note']);
  });

  it('shows only the latest gate batch by its stamp, not array position', () => {
    const views = uatProcesses(
      qualityInput({
        cell: cell('uat', 'passed', { startedAt: '2026-07-20T12:00:00.000Z', endedAt: NOW }),
        gateRuns: [
          run('uat', 'test (web)', 0, { runAt: NOW }),
          run('uat', 'test (web)', 1, { runAt: '2026-07-20T11:00:00.000Z' }),
        ],
      }),
    );
    const evidence = views[0]!.evidence as { kind: 'gates'; rows: readonly EvidenceRow[] };
    expect(evidence.rows).toHaveLength(1);
    expect(evidence.rows[0]!.status).toBe('pass');
  });

  it('bounds gate rows at 8 and names the remainder', () => {
    const gates = Array.from({ length: 10 }, (_, i) => run('uat', `test (${i})`, 0, { runAt: NOW }));
    const views = uatProcesses(qualityInput({ gateRuns: gates }));
    const evidence = views[0]!.evidence as { kind: 'gates'; rows: readonly EvidenceRow[]; passed: number };
    expect(evidence.rows).toHaveLength(9);
    expect(evidence.passed).toBe(10);
    expect(evidence.rows.at(-1)).toMatchObject({ status: 'note', label: 'more' });
    expect(evidence.rows.at(-1)!.detail).toContain('2');
  });

  it('renders advisory tester observations as note rows and never a fix', () => {
    const tester = processRun({ id: 5, status: 'passed', resultKind: 'observed' });
    const views = uatProcesses(
      qualityInput({
        processRuns: [tester],
        uatFindings: [uatFinding('high', { processRunId: 5, title: 'slow query' })],
      }),
    );
    const row = views.find((p) => p.id === 'tester')!;
    expect(row.status).toBe('pass');
    expect(rowsOf(row)).toMatchObject([{ status: 'note', label: 'high' }]);
    expect(rowsOf(row)[0]!.detail).toContain('slow query');
    expect(views.map((p) => p.id)).not.toContain('fix');
  });

  it('scopes observations to the LATEST tester run by invocation id', () => {
    const tester = processRun({ id: 9, status: 'passed', resultKind: 'observed' });
    const views = uatProcesses(
      qualityInput({
        processRuns: [processRun({ id: 1, status: 'passed', resultKind: 'observed' }), tester],
        uatFindings: [uatFinding('high', { processRunId: 1, title: 'from the older run' })],
      }),
    );
    expect(rowsOf(views.find((p) => p.id === 'tester')!)).toEqual([]);
  });

  it('reads a verifier failure as a failed tester process', () => {
    const views = uatProcesses(
      qualityInput({
        processRuns: [processRun({ status: 'passed', resultKind: 'verification-failed' })],
      }),
    );
    const tester = views.find((p) => p.id === 'tester')!;
    expect(tester.status).toBe('fail');
    expect(tester.detail).toContain('verifier failed');
  });

  it('reads an execution crash as failed and interrupts as note', () => {
    const crashed = uatProcesses(
      qualityInput({
        processRuns: [processRun({ status: 'failed', resultKind: 'execution-failed' })],
      }),
    ).find((p) => p.id === 'tester')!;
    expect(crashed.status).toBe('fail');
    expect(crashed.detail).toContain('execution failed');

    const interrupted = uatProcesses(
      qualityInput({
        processRuns: [processRun({ status: 'interrupted', resultKind: 'interrupted' })],
      }),
    ).find((p) => p.id === 'tester')!;
    expect(interrupted.status).toBe('note');
  });

  it('reads a stale tester run as note, never as pass or fail', () => {
    const views = uatProcesses(
      qualityInput({
        processRuns: [processRun({ status: 'stale', endedAt: null, resultKind: null })],
      }),
    );
    const tester = views.find((p) => p.id === 'tester')!;
    expect(tester.status).toBe('note');
    expect(tester.status).not.toBe('pass');
    expect(tester.status).not.toBe('fail');
  });

  it('shows the configured assignment only before anything ran; recorded identity wins after', () => {
    const configured = { provider: 'claude', model: 'opus' };
    const before = uatProcesses(
      qualityInput({
        cell: cell('uat', 'pending'),
        configured,
        processRuns: [],
      }),
    ).find((p) => p.id === 'tester')!;
    expect(before.status).toBe('pending');
    expect(before.configuredExecution).toMatchObject({ provider: 'claude', model: 'opus' });
    expect(before.execution).toBeUndefined();

    const after = uatProcesses(
      qualityInput({
        configured,
        processRuns: [processRun({ id: 4, provider: 'codex', model: 'sol' })],
      }),
    ).find((p) => p.id === 'tester')!;
    expect(after.execution).toMatchObject({ provider: 'codex', model: 'sol' });
    expect(after.configuredExecution).toBeUndefined();
  });

  it('omits tokens unless measured, then renders the recorded view', () => {
    const bare = uatProcesses(qualityInput()).find((p) => p.id === 'tester')!;
    expect(bare.tokens).toBeUndefined();

    const measured = uatProcesses(
      qualityInput({ tokens: { total: 150, estimatedCalls: 0 } }),
    ).find((p) => p.id === 'tester')!;
    expect(measured.tokens).toEqual({ state: 'measured', total: '150', exact: '150' });
  });

  it('keeps services as pending config before the stage runs, naming the configured services after', () => {
    const before = uatProcesses(
      qualityInput({ cell: cell('uat', 'pending'), services: ['web', 'api'] }),
    ).find((p) => p.id === 'services')!;
    expect(before.status).toBe('pending');
    expect(before.detail).toBe('web · api');

    const after = uatProcesses(
      qualityInput({ services: ['web'] }),
    ).find((p) => p.id === 'services')!;
    expect(after.status).toBe('note');
    expect(after.detail).toBe('web');
  });

  it('notes the absence of services rather than claiming any', () => {
    const views = uatProcesses(qualityInput({ services: [] }));
    expect(views.find((p) => p.id === 'services')!.detail).toContain('no service blocks');
  });

  it('renders one fix row for an exhausted series, with every round in its evidence', () => {
    const views = uatProcesses(
      qualityInput({
        rounds: [
          round({ id: 1, round: 1, status: 'failed' }),
          round({ id: 2, round: 2, status: 'exhausted' }),
        ],
      }),
    );
    const fix = views.filter((p) => p.id === 'fix');
    expect(fix).toHaveLength(1);
    expect(rowsOf(fix[0]!).map((r) => r.label)).toEqual(['round 1', 'round 2']);
    expect(fix[0]!.status).toBe('fail');
    expect(fix[0]!.detail).toBe('no fix attempts left');
  });

  it('renders the round budget from the STORED max_rounds, never the live manifest', () => {
    const views = uatProcesses(
      qualityInput({ rounds: [round({ maxRounds: 3 })] }),
    );
    const fix = views.find((p) => p.id === 'fix')!;
    expect(rowsOf(fix)[0]!.detail).toContain('max 3');
  });

  it('renders a crash without a round as no fix and a failed process row', () => {
    const views = uatProcesses(
      qualityInput({
        cell: cell('uat', 'running'),
        processRuns: [processRun({ status: 'failed', resultKind: 'execution-failed' })],
      }),
    );
    expect(views.map((p) => p.id)).toEqual(['gates', 'services', 'tester']);
    expect(views.find((p) => p.id === 'tester')!.status).toBe('fail');
  });

  it('has no tester execution to claim before the stage ran', () => {
    const tester = uatProcesses(qualityInput({ cell: cell('uat', 'pending') })).find(
      (p) => p.id === 'tester',
    )!;
    expect(tester.status).toBe('pending');
    expect(tester.execution).toBeUndefined();
  });
});

describe('reviewProcesses', () => {
  const reviewCell = {
    stageKey: 'review' as const,
    status: 'passed' as const,
    startedAt: '2026-07-20T12:00:00.000Z',
    endedAt: '2026-07-20T12:02:00.000Z',
  };

  it('emits gates, services, review in registry order when nothing triggered recovery', () => {
    const views = reviewProcesses(
      qualityInput({
        cell: reviewCell,
        processRuns: [processRun({ stageKey: 'review', processId: 'review', status: 'passed', resultKind: 'validated' })],
      }),
    );
    expect(views.map((p) => p.id)).toEqual(['gates', 'services', 'review']);
  });

  it('inserts the fix process after review for a findings-triggered round', () => {
    const views = reviewProcesses(
      qualityInput({
        cell: reviewCell,
        rounds: [
          round({
            sourceStage: 'review',
            sourceProcessId: 'review',
            triggerKind: 'blocking-review-findings',
          }),
        ],
      }),
    );
    expect(views.map((p) => p.id)).toEqual(['gates', 'services', 'review', 'fix']);
  });

  it('inserts the fix process after gates for a review gate-triggered round', () => {
    const views = reviewProcesses(
      qualityInput({
        cell: reviewCell,
        rounds: [round({ sourceStage: 'review', sourceProcessId: 'gates' })],
      }),
    );
    expect(views.map((p) => p.id)).toEqual(['gates', 'fix', 'services', 'review']);
  });

  it('reads blocking findings as a failed review process naming the count', () => {
    const views = reviewProcesses(
      qualityInput({
        cell: { ...reviewCell, status: 'failed' },
        processRuns: [
          processRun({ stageKey: 'review', processId: 'review', status: 'failed', resultKind: 'blocking' }),
        ],
        findings: [finding('critical', { runAt: NOW }), finding('high', { runAt: NOW })],
      }),
    );
    const review = views.find((p) => p.id === 'review')!;
    expect(review.status).toBe('fail');
    expect(review.detail).toContain('2 blocking findings');
    const evidence = review.evidence as { kind: 'findings'; rows: readonly EvidenceRow[]; blocking: number };
    expect(evidence.blocking).toBe(2);
  });

  it('reads a validated review as passed, distinct from blocking', () => {
    const views = reviewProcesses(
      qualityInput({
        cell: reviewCell,
        processRuns: [
          processRun({ stageKey: 'review', processId: 'review', status: 'passed', resultKind: 'validated' }),
        ],
      }),
    );
    const review = views.find((p) => p.id === 'review')!;
    expect(review.status).toBe('pass');
    expect(review.detail).toContain('no blocking findings');
  });

  it('reads an execution crash as failed with the cause named', () => {
    const views = reviewProcesses(
      qualityInput({
        cell: { ...reviewCell, status: 'failed' },
        processRuns: [
          processRun({ stageKey: 'review', processId: 'review', status: 'failed', resultKind: 'execution-failed' }),
        ],
      }),
    );
    const review = views.find((p) => p.id === 'review')!;
    expect(review.status).toBe('fail');
    expect(review.detail).toContain('execution failed');
  });

  it('shows only the latest findings batch and bounds it at 6', () => {
    const stale = finding('high', { runAt: '2026-07-20T11:00:00.000Z', title: 'stale' });
    const fresh = Array.from({ length: 8 }, (_, i) =>
      finding('low', { runAt: NOW, title: `fresh ${i}` }),
    );
    const views = reviewProcesses(
      qualityInput({
        cell: reviewCell,
        processRuns: [
          processRun({ stageKey: 'review', processId: 'review', status: 'passed', resultKind: 'validated' }),
        ],
        findings: [stale, ...fresh],
      }),
    );
    const review = views.find((p) => p.id === 'review')!;
    const rows = rowsOf(review);
    expect(rows).toHaveLength(7);
    expect(rows[0]!.detail).toContain('fresh 0');
    expect(rows.at(-1)).toMatchObject({ status: 'note', label: 'more' });
    expect(rows.at(-1)!.detail).toContain('2');
  });
});
