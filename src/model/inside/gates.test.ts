import { describe, it, expect } from 'vitest';
import type { GateRun } from '../../store/gateRuns.js';
import type { StepperCell } from '../stepper.js';
import type { StageKey, StageStatus } from '../types.js';
import { reviewInside, uatInside } from './gates.js';

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
    runAt: '2026-07-20T12:00:00.000Z',
    gateName,
    exitCode,
    startedAt: null,
    endedAt: null,
    repo: null,
    command: null,
    args: null,
    ...extra,
  };
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
    const ops = reviewInside(cell('review', 'passed'), runs, NOW).ops;
    expect(ops.map((o) => o.name)).toEqual(['lint (web)', 'typecheck (web)', 'test (api)']);
  });

  it('reads a failing gate as failed, naming the exit code', () => {
    const ops = reviewInside(cell('review', 'failed'), [run('review', 'lint (web)', 1)], NOW).ops;
    const lint = ops.find((o) => o.name === 'lint (web)')!;
    expect(lint.status).toBe('fail');
    expect(lint.detail).toContain('exit 1');
  });

  it('never reads a gate the repo cannot answer as a pass', () => {
    // exitCode null means there was no script to run. Showing it green would
    // claim a check karst never made.
    const ops = reviewInside(cell('review', 'passed'), [run('review', 'lint (web)', null)], NOW).ops;
    const lint = ops.find((o) => o.name === 'lint (web)')!;
    expect(lint.status).toBe('note');
    expect(lint.status).not.toBe('pass');
    expect(lint.detail).toContain('nothing to run');
  });

  it('renders only the latest batch when a gate has been run more than once', () => {
    const first = run('review', 'lint (web)', 1, { runAt: '2026-07-20T12:00:00.000Z' });
    const second = run('review', 'lint (web)', 0, { runAt: '2026-07-20T12:20:00.000Z' });
    const ops = reviewInside(cell('review', 'passed'), [first, second], NOW).ops;
    expect(ops).toHaveLength(1);
    expect(ops[0]!.status).toBe('pass');
  });

  it('picks the latest batch by its stamp, not by where it sits in the array', () => {
    // Otherwise this silently depends on the store returning rows in insertion
    // order, which no query contract guarantees — an added index or a planner
    // change would surface a stale run with nothing failing to say so.
    const older = run('review', 'lint (web)', 1, { runAt: '2026-07-20T12:00:00.000Z' });
    const newer = run('review', 'lint (web)', 0, { runAt: '2026-07-20T12:20:00.000Z' });
    const ops = reviewInside(cell('review', 'passed'), [newer, older], NOW).ops;
    expect(ops[0]!.status).toBe('pass');
  });

  it('states the changes surface as still to come while the gate runs, and as opened once a real openDiff recorded it', () => {
    const running = reviewInside(cell('review', 'running'), [], NOW).ops;
    expect(running.at(-1)).toMatchObject({ name: 'changes', status: 'note' });

    const done = reviewInside(
      cell('review', 'failed'),
      [run('review', 'lint (web)', 1), run('review', 'changes', 0)],
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
      NOW,
    ).ops;
    expect(ops.filter((o) => o.name === 'changes')).toHaveLength(1);
    expect(ops[0]!.name).toBe('lint (web)');
  });

  it('emits no changes row when nothing opened it', () => {
    // A finished stage with real gate evidence but no recorded 'changes' run
    // means no `openDiff` was wired for that run (e.g. no host supplied one).
    // The row must say nothing, never claim a control nobody performed.
    const done = reviewInside(cell('review', 'passed'), [run('review', 'lint (web)', 0)], NOW).ops;
    expect(done.find((o) => o.name === 'changes')).toBeUndefined();

    const failed = reviewInside(cell('review', 'failed'), [run('review', 'lint (web)', 1)], NOW).ops;
    expect(failed.find((o) => o.name === 'changes')).toBeUndefined();
  });

  it('names no changes row before the stage has run — nothing opened or promised yet', () => {
    const ops = reviewInside(cell('review', 'pending'), [], NOW).ops;
    expect(ops.find((o) => o.name === 'changes')).toBeUndefined();
  });

  it('shows a gate duration when the run recorded one', () => {
    const runs = [
      run('review', 'lint (web)', 0, {
        startedAt: '2026-07-20T12:00:00.000Z',
        endedAt: '2026-07-20T12:00:06.400Z',
      }),
    ];
    const ops = reviewInside(cell('review', 'passed'), runs, NOW).ops;
    expect(ops.find((o) => o.name === 'lint (web)')!.duration).toBe('6.4s');
  });

  it('says the gates are not known yet before the stage has run', () => {
    // Review cannot name its gates before it probes a repository for them, so
    // it says that rather than promising a list it may not run.
    const strip = reviewInside(cell('review', 'pending'), [], NOW);
    expect(strip.ops).toEqual([
      { status: 'pending', name: 'gates', detail: 'resolved per repository when the stage runs', duration: '' },
    ]);
    expect(strip.blurb).not.toBe('');
    expect(strip.clock).toBe('has not run yet');
  });

  it('shows nothing for a finished stage that recorded no gates', () => {
    // A finished stage with no rows predates this record; inventing one would be
    // a guess, and a pending row on a passed stage would be a false promise.
    expect(reviewInside(cell('review', 'passed'), [], NOW).ops).toEqual([]);
  });

  it('ignores gate rows belonging to another stage', () => {
    // A uat failure is not review evidence. With nothing of its own recorded,
    // review has nothing to show — not a borrowed red row.
    const ops = reviewInside(cell('review', 'passed'), [run('uat', 'test (web)', 1)], NOW).ops;
    expect(ops).toEqual([]);
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
