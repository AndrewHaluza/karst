import { describe, it, expect } from 'vitest';
import type { PhaseMark } from '../../store/phaseMarks.js';
import type { StepperCell } from '../stepper.js';
import type { StageKey, StageStatus } from '../types.js';
import { implInside, fixInside, reportedPhases } from './agent.js';
import { formatTime } from './types.js';

const NOW = '2026-07-20T12:30:00.000Z';
const SESSION = { sessionId: '0f3a91', agentState: 'running', model: 'claude-opus-4-8' };

function cell(stageKey: StageKey, status: StageStatus, extra: Partial<StepperCell> = {}): StepperCell {
  return { stageKey, status, ...extra };
}

let nextMarkId = 0;
function mark(phaseName: string, markedAt: string, extra: Partial<PhaseMark> = {}): PhaseMark {
  return {
    id: (nextMarkId += 1),
    ticketId: 1,
    stageKey: 'impl',
    attempt: 0,
    phaseName,
    markedAt,
    implementationRunId: null,
    implementationSegmentId: null,
    ...extra,
  };
}

const at = (hhmm: string) => `2026-07-20T${hhmm}:00.000Z`;

describe('reportedPhases', () => {
  // Exported so the dashboard's impl segment fills its phase pips from the SAME
  // derivation the strip lists. Two answers to "which phase is the agent in" is
  // the same class of bug as two answers to needs-you.
  it('reports each phase at its first mark, in report order', () => {
    const marks = [mark('plan', at('10:05')), mark('research', at('10:00'))];
    // Ordered by id (the rowid alias), never by array position: listPhaseMarks
    // promises no order.
    expect(reportedPhases([marks[1]!, marks[0]!], cell('impl', 'running')).map((m) => m.phaseName))
      .toEqual(['plan', 'research']);
  });

  it('reports a repeated phase once, at its first mark', () => {
    // Approaches loop legitimately (research → plan → research); a repeat
    // counter would make ordinary iteration read as thrashing.
    const first = mark('research', at('10:00'));
    const out = reportedPhases(
      [first, mark('plan', at('10:05')), mark('research', at('10:10'))],
      cell('impl', 'running'),
    );
    expect(out.map((m) => m.phaseName)).toEqual(['research', 'plan']);
    expect(out[0]!.id).toBe(first.id);
  });

  it('ignores marks from another attempt', () => {
    expect(
      reportedPhases([mark('research', at('10:00'), { attempt: 0 })],
        cell('impl', 'running', { attempt: 1 })),
    ).toEqual([]);
  });

  it('ignores marks from another stage', () => {
    expect(
      reportedPhases([mark('research', at('10:00'), { stageKey: 'fix' })], cell('impl', 'running')),
    ).toEqual([]);
  });
});

describe('implInside', () => {
  it('names the session and the model it is running on', () => {
    const ops = implInside(cell('impl', 'running'), SESSION, ['research', 'plan'], [], NOW).ops;
    const agent = ops.find((o) => o.name === 'agent')!;
    expect(agent.status).toBe('run');
    expect(agent.detail).toContain('0f3a91');
    expect(agent.detail).toContain('claude-opus-4-8');
  });

  it('reads a session waiting on the user as waiting, not running', () => {
    const waiting = { ...SESSION, agentState: 'waiting' };
    const ops = implInside(cell('impl', 'running'), waiting, [], [], NOW).ops;
    expect(ops.find((o) => o.name === 'agent')!.status).toBe('wait');
  });

  it('states the marker rule rather than a live driver status', () => {
    // The driver's `awaiting-marker` reason is never persisted, so this is the
    // rule impl advances by — not a claim about what the driver is doing now.
    const ops = implInside(cell('impl', 'running'), SESSION, [], [], NOW).ops;
    expect(ops.find((o) => o.name === 'driver')!.status).toBe('note');
    expect(ops.find((o) => o.name === 'driver')!.detail).toContain('done marker');
  });

  it('lists the declared phases without ever giving one a status', () => {
    // The no-inference guarantee: karst does not observe the agent working
    // through an approach's phases, so it must not draw them as progress.
    const phases = ['describe', 'research', 'plan', 'implement'];
    const ops = implInside(cell('impl', 'running'), SESSION, phases, [], NOW).ops;
    const listed = ops.find((o) => o.name === 'phases')!;
    expect(listed.status).toBe('note');
    expect(listed.detail).toBe('describe → research → plan → implement');
    for (const phase of phases) {
      expect(ops.filter((o) => o.name === phase)).toEqual([]);
    }
  });

  it('emits the same number of rows however many phases the approach declares, when none were reported', () => {
    // The row count must not track the DECLARED phase count, or the panel is
    // drawing one step per phase the agent was merely asked to run — which is
    // exactly the fabrication this forbids. Reported phases are a different
    // thing entirely: they are evidence, and they do get rows (below).
    const few = implInside(cell('impl', 'running'), SESSION, ['a'], [], NOW).ops.length;
    const many = implInside(
      cell('impl', 'running'),
      SESSION,
      ['a', 'b', 'c', 'd', 'e', 'f'],
      [],
      NOW,
    ).ops.length;
    expect(few).toBe(many);
  });

  it('adds one row per REPORTED phase and none for a merely declared one', () => {
    const marks = [mark('describe', at('12:01')), mark('research', at('12:05'))];
    const four = implInside(
      cell('impl', 'running'),
      SESSION,
      ['describe', 'research', 'plan', 'implement'],
      marks,
      NOW,
    ).ops;
    const six = implInside(
      cell('impl', 'running'),
      SESSION,
      ['describe', 'research', 'plan', 'implement', 'verify', 'polish'],
      marks,
      NOW,
    ).ops;
    // Two more DECLARED phases, same marks: the extra declarations join the one
    // trailing note row rather than each earning a row of their own.
    expect(six.length).toBe(four.length);
    expect(four.map((o) => o.name)).toEqual([
      'agent',
      'driver',
      'describe',
      'research',
      'not reported',
    ]);
  });

  it('leaves today\'s four rows byte-identical when nothing was reported', () => {
    // An approach that never fired a marker must look exactly as it did before
    // phase marks existed. Absence of a mark is evidence of nothing.
    const ops = implInside(
      cell('impl', 'running'),
      SESSION,
      ['describe', 'research'],
      [],
      NOW,
    ).ops;
    expect(ops).toEqual([
      {
        status: 'run',
        name: 'agent',
        detail: 'session 0f3a91 — claude-opus-4-8',
        duration: '',
      },
      {
        status: 'note',
        name: 'driver',
        detail:
          'impl advances only on the explicit done marker — a session ending is not a verdict',
        duration: '',
      },
      {
        status: 'note',
        name: 'phases',
        detail: 'describe → research',
        duration: '',
      },
      {
        status: 'note',
        name: 'recorded',
        detail: 'karst records no per-phase state — the agent runs these itself inside impl',
        duration: '',
      },
    ]);
  });

  it('says a declared phase was reported, at the time it was reported', () => {
    const m = mark('research', at('12:41'));
    const ops = implInside(cell('impl', 'running'), SESSION, ['research'], [m], NOW).ops;
    const row = ops.find((o) => o.name === 'research')!;
    expect(row.status).toBe('pass');
    expect(row.detail).toBe(`reported ${formatTime(m.markedAt)}`);
  });

  it('never claims a reported phase was completed or finished', () => {
    // "reported" is the whole point: the agent ran a command on ENTERING the
    // phase. karst has no evidence it ever came out the other side.
    const ops = implInside(
      cell('impl', 'running'),
      SESSION,
      ['research', 'plan'],
      [mark('research', at('12:41'))],
      NOW,
    ).ops;
    const text = ops.map((o) => `${o.name} ${o.detail}`).join(' | ');
    expect(text).toContain('reported');
    expect(text).not.toContain('completed');
    expect(text).not.toContain('finished');
    expect(text).not.toContain('skipped');
  });

  it('names the declared phases that were not reported, without judging them', () => {
    const ops = implInside(
      cell('impl', 'running'),
      SESSION,
      ['describe', 'research', 'plan', 'implement'],
      [mark('describe', at('12:01')), mark('research', at('12:05'))],
      NOW,
    ).ops;
    const row = ops.find((o) => o.name === 'not reported')!;
    expect(row.status).toBe('note');
    expect(row.detail).toBe('plan → implement');
  });

  it('adds no not-reported row when every declared phase was reported', () => {
    const ops = implInside(
      cell('impl', 'running'),
      SESSION,
      ['research', 'plan'],
      [mark('research', at('12:41')), mark('plan', at('12:50'))],
      NOW,
    ).ops;
    expect(ops.map((o) => o.name)).toEqual(['agent', 'driver', 'research', 'plan']);
  });

  it('shows a reported phase the approach never declared, and says so', () => {
    const m = mark('spike', at('12:55'));
    const ops = implInside(cell('impl', 'running'), SESSION, ['research'], [m], NOW).ops;
    const row = ops.find((o) => o.name === 'spike')!;
    expect(row.status).toBe('note');
    expect(row.detail).toBe(
      `reported ${formatTime(m.markedAt)} · not in this approach's workflow`,
    );
  });

  it('drops the phases and recorded rows once anything has been reported', () => {
    const ops = implInside(
      cell('impl', 'running'),
      SESSION,
      ['research'],
      [mark('research', at('12:41'))],
      NOW,
    ).ops;
    expect(ops.find((o) => o.name === 'phases')).toBeUndefined();
    expect(ops.find((o) => o.name === 'recorded')).toBeUndefined();
  });

  it('renders a phase reported twice once, at its FIRST mark', () => {
    const first = mark('research', at('12:05'));
    const again = mark('research', at('12:40'));
    const ops = implInside(
      cell('impl', 'running'),
      SESSION,
      ['research', 'plan'],
      [first, mark('plan', at('12:20')), again],
      NOW,
    ).ops;
    expect(ops.filter((o) => o.name === 'research')).toHaveLength(1);
    expect(ops.find((o) => o.name === 'research')!.detail).toBe(
      `reported ${formatTime(first.markedAt)}`,
    );
    // Reported order, taken from the first mark of each phase.
    expect(ops.map((o) => o.name)).toEqual(['agent', 'driver', 'research', 'plan']);
  });

  it('selects marks by attempt and stage, not by array position', () => {
    // `listPhaseMarks` returns EVERY mark a ticket ever recorded, ungrouped and
    // in whatever order the query planner produced. Picking "the last batch" off
    // the end of the array would couple this to an ordering nothing promises —
    // the bug fixed in 3e21e5c for gate runs. So: scrambled input, same answer.
    const scrambled = [
      mark('research', at('12:25'), { id: 99, attempt: 1 }),
      mark('research', at('11:05'), { id: 12, attempt: 0 }),
      mark('plan', at('12:20'), { id: 90, attempt: 1 }),
      mark('rebase', at('12:15'), { id: 40, stageKey: 'fix', attempt: 1 }),
      mark('describe', at('11:01'), { id: 11, attempt: 0 }),
      mark('describe', at('12:10'), { id: 91, attempt: 1 }),
    ];
    const ops = implInside(
      cell('impl', 'running', { attempt: 1 }),
      SESSION,
      ['describe', 'research', 'plan'],
      scrambled,
      NOW,
    ).ops;
    // Attempt 1's impl marks only, in id order: plan(90) → describe(91) → research(99).
    expect(ops.map((o) => o.name)).toEqual(['agent', 'driver', 'plan', 'describe', 'research']);
    expect(ops.find((o) => o.name === 'plan')!.detail).toBe(`reported ${formatTime(at('12:20'))}`);
  });

  it('ignores marks from another attempt entirely', () => {
    const ops = implInside(
      cell('impl', 'running', { attempt: 2 }),
      SESSION,
      ['research'],
      [mark('research', at('12:41'), { attempt: 1 })],
      NOW,
    ).ops;
    // Nothing reported in THIS attempt: today's rows, unchanged.
    expect(ops.map((o) => o.name)).toEqual(['agent', 'driver', 'phases', 'recorded']);
  });

  it('says plainly that no per-phase state is recorded', () => {
    const ops = implInside(cell('impl', 'running'), SESSION, ['research'], [], NOW).ops;
    expect(ops.find((o) => o.name === 'recorded')!.detail).toContain('no per-phase state');
  });

  it('says the approach declares no workflow when it has no phases', () => {
    const ops = implInside(cell('impl', 'running'), SESSION, [], [], NOW).ops;
    expect(ops.find((o) => o.name === 'phases')!.detail).toContain('declares no workflow');
  });

  it('reports a session karst never captured as a note, not as a running agent', () => {
    const none = { sessionId: null, agentState: 'none', model: null };
    const agent = implInside(cell('impl', 'running'), none, [], [], NOW).ops.find(
      (o) => o.name === 'agent',
    )!;
    expect(agent.status).toBe('note');
    expect(agent.detail).toContain('no session');
  });

  it('shows the declared phases before the stage has run — declared, not observed', () => {
    // The approach's workflow phases are static config, known before impl ever
    // starts — the same class of fact as a gate's spec list — so pending shows
    // them (note-status: declared, never observed), not the blurb.
    const none = { sessionId: null, agentState: 'none', model: null };
    const strip = implInside(cell('impl', 'pending'), none, ['research', 'plan'], [], NOW);
    expect(strip.clock).toBe('has not run yet');
    expect(strip.ops.map((o) => o.name)).toEqual(['agent', 'driver', 'phases', 'recorded']);
    expect(strip.ops.find((o) => o.name === 'agent')!.status).toBe('note');
    expect(strip.ops.find((o) => o.name === 'phases')!.detail).toBe('research → plan');
  });
});

describe('fixInside', () => {
  it('quotes the prompt the resumed session is actually given', () => {
    const ops = fixInside(cell('fix', 'running'), '0f3a91', 1, NOW).ops;
    const agent = ops.find((o) => o.name === 'agent')!;
    expect(agent.status).toBe('run');
    expect(agent.detail).toContain('0f3a91');
    expect(agent.detail).toContain('Address the failing review gates, then stop.');
  });

  it('states where a pass returns to, and how many attempts are left', () => {
    const ops = fixInside(cell('fix', 'running'), '0f3a91', 2, NOW).ops;
    const returns = ops.find((o) => o.name === 'returns')!;
    expect(returns.status).toBe('note');
    expect(returns.detail).toContain('review');
    expect(returns.detail).toContain('1 attempt left');
  });

  it('says the cap is reached rather than promising an attempt that will not come', () => {
    const ops = fixInside(cell('fix', 'running'), '0f3a91', 3, NOW).ops;
    expect(ops.find((o) => o.name === 'returns')!.detail).toContain('no attempts left');
  });

  it('reports a missing captured session, which is the one way fix cannot run', () => {
    const agent = fixInside(cell('fix', 'running'), null, 1, NOW).ops.find(
      (o) => o.name === 'agent',
    )!;
    expect(agent.status).toBe('note');
    expect(agent.detail).toContain('no session');
  });

  it('invents no per-edit rows — fix records nothing but that it ran', () => {
    const ops = fixInside(cell('fix', 'passed'), '0f3a91', 1, NOW).ops;
    expect(ops.map((o) => o.name)).toEqual(['agent', 'returns']);
  });

  it('shows where it returns to before the loop has been entered', () => {
    // "returns to review, N attempts left" is static config, not an observation
    // of the run — known before fix ever starts.
    const ops = fixInside(cell('fix', 'pending'), null, 0, NOW).ops;
    expect(ops.map((o) => o.name)).toEqual(['agent', 'returns']);
    expect(ops.find((o) => o.name === 'agent')!.status).toBe('note');
    expect(ops.find((o) => o.name === 'returns')!.detail).toContain('3 attempts left');
  });
});
