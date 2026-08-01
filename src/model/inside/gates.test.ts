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
    ...extra,
  };
}

describe('reviewInside', () => {
  it('lists every review gate in declaration order, whatever order they were recorded', () => {
    const runs = [
      run('review', 'test', 0),
      run('review', 'lint', 0),
      run('review', 'typecheck', 0),
    ];
    const ops = reviewInside(cell('review', 'passed'), runs, NOW).ops;
    expect(ops.slice(0, 3).map((o) => o.name)).toEqual(['lint', 'typecheck', 'test']);
  });

  it('reads a failing gate as failed, naming the command and the exit code', () => {
    const ops = reviewInside(cell('review', 'failed'), [run('review', 'lint', 1)], NOW).ops;
    const lint = ops.find((o) => o.name === 'lint')!;
    expect(lint.status).toBe('fail');
    expect(lint.detail).toContain('npm run lint');
    expect(lint.detail).toContain('exit 1');
  });

  it('never reads a gate the repo cannot answer as a pass', () => {
    // exitCode null means there was no script to run. Showing it green would
    // claim a check karst never made.
    const ops = reviewInside(cell('review', 'passed'), [run('review', 'lint', null)], NOW).ops;
    const lint = ops.find((o) => o.name === 'lint')!;
    expect(lint.status).toBe('note');
    expect(lint.status).not.toBe('pass');
    expect(lint.detail).toContain('no "lint" script');
  });

  it('shows gates not yet reported as pending while the stage is running', () => {
    // The gate list is static, so naming what is still to come is truthful.
    const ops = reviewInside(cell('review', 'running'), [run('review', 'lint', 0)], NOW).ops;
    expect(ops.find((o) => o.name === 'lint')!.status).toBe('pass');
    expect(ops.find((o) => o.name === 'typecheck')!.status).toBe('pending');
    expect(ops.find((o) => o.name === 'test')!.status).toBe('pending');
  });

  it('renders only the latest batch when a gate has been run more than once', () => {
    const first = run('review', 'lint', 1, { runAt: '2026-07-20T12:00:00.000Z' });
    const second = run('review', 'lint', 0, { runAt: '2026-07-20T12:20:00.000Z' });
    const ops = reviewInside(cell('review', 'passed'), [first, second], NOW).ops;
    expect(ops.find((o) => o.name === 'lint')!.status).toBe('pass');
  });

  it('picks the latest batch by its stamp, not by where it sits in the array', () => {
    // Otherwise this silently depends on the store returning rows in insertion
    // order, which no query contract guarantees — an added index or a planner
    // change would surface a stale run with nothing failing to say so.
    const older = run('review', 'lint', 1, { runAt: '2026-07-20T12:00:00.000Z' });
    const newer = run('review', 'lint', 0, { runAt: '2026-07-20T12:20:00.000Z' });
    const ops = reviewInside(cell('review', 'passed'), [newer, older], NOW).ops;
    expect(ops.find((o) => o.name === 'lint')!.status).toBe('pass');
  });

  it('states the diff as still to come while the gate runs, and as opened once it finished', () => {
    const running = reviewInside(cell('review', 'running'), [], NOW).ops;
    expect(running.at(-1)).toMatchObject({ name: 'diff', status: 'note' });

    const done = reviewInside(cell('review', 'failed'), [run('review', 'lint', 1)], NOW).ops;
    // review opens the diff on both verdicts, so this is observed, not inferred.
    expect(done.at(-1)).toMatchObject({ name: 'diff', status: 'pass' });
  });

  it('names no diff row before the stage has run — nothing opened or promised yet', () => {
    const ops = reviewInside(cell('review', 'pending'), [], NOW).ops;
    expect(ops.find((o) => o.name === 'diff')).toBeUndefined();
  });

  it('shows a gate duration when the run recorded one', () => {
    const runs = [
      run('review', 'lint', 0, {
        startedAt: '2026-07-20T12:00:00.000Z',
        endedAt: '2026-07-20T12:00:06.400Z',
      }),
    ];
    const ops = reviewInside(cell('review', 'passed'), runs, NOW).ops;
    expect(ops.find((o) => o.name === 'lint')!.duration).toBe('6.4s');
  });

  it('shows the gate list as pending before the stage has run, and no diff row yet', () => {
    // The gate list is static, so naming it before the stage starts is truthful
    // — it just isn't evidence yet. No "diff" row: it neither opened nor is
    // about to, so nothing observed or promised exists to name.
    const strip = reviewInside(cell('review', 'pending'), [], NOW);
    expect(strip.ops.map((o) => o.name)).toEqual(['lint', 'typecheck', 'test']);
    expect(strip.ops.every((o) => o.status === 'pending')).toBe(true);
    expect(strip.blurb).not.toBe('');
    expect(strip.clock).toBe('has not run yet');
  });

  it('ignores gate rows belonging to another stage', () => {
    // A uat failure is not review evidence. With nothing of its own recorded,
    // review has nothing to show — not a borrowed red row.
    const ops = reviewInside(cell('review', 'passed'), [run('uat', 'test', 1)], NOW).ops;
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
