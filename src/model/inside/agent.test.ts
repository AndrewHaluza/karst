import { describe, it, expect } from 'vitest';
import type {
  ImplementationRun,
  ImplementationSegment,
  ImplementationTimeline,
} from '../../store/implementationRuns.js';
import type { PhaseMark } from '../../store/phaseMarks.js';
import type { StepperCell } from '../stepper.js';
import type { StageKey, StageStatus } from '../types.js';
import { implementationSessionProcess, reportedPhases, tokenView } from './agent.js';
import { formatTime, type EvidenceRow, type InsideEvidenceTarget, type InsideProcessView } from './types.js';

const NOW = '2026-07-20T12:30:00.000Z';

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

describe('implementationSessionProcess', () => {
  const runAt = (t: string) => `2026-07-20T${t}:00.000Z`;

  function segment(over: Partial<ImplementationSegment> = {}): ImplementationSegment {
    return {
      id: 1,
      implementationRunId: 1,
      provider: 'claude',
      model: 'claude-opus-4-8',
      providerSessionId: 'sess-1',
      reason: null,
      status: 'running',
      launchIntentId: 1,
      startedAt: runAt('12:00'),
      endedAt: null,
      ...over,
    };
  }

  function run(over: Partial<ImplementationRun> = {}): ImplementationRun {
    return {
      id: 1,
      ticketId: 1,
      processRunId: 1,
      attempt: 0,
      status: 'running',
      startedAt: runAt('12:00'),
      endedAt: null,
      ...over,
    };
  }

  function tl(
    segments: readonly ImplementationSegment[],
    over: Partial<ImplementationRun> = {},
  ): ImplementationTimeline {
    return { run: run(over), segments: [...segments] };
  }

  function rows(process: InsideProcessView): readonly EvidenceRow[] {
    const evidence = process.evidence;
    if (evidence === undefined || evidence.kind !== 'timeline') {
      throw new Error('expected timeline evidence');
    }
    return evidence.rows;
  }

  it('renders one session process with a timeline headed by the run start', () => {
    const process = implementationSessionProcess(
      cell('impl', 'running'),
      tl([segment({ id: 1 })]),
      [],
      undefined,
      undefined,
      NOW,
    );
    expect(process.id).toBe('session');
    expect(process.status).toBe('run');
    expect(process.evidence).toMatchObject({ kind: 'timeline' });
    const first = rows(process)[0]!;
    expect(first).toMatchObject({ label: 'started', status: 'note' });
    expect(first.detail).toBe(formatTime(runAt('12:00')));
    expect(first.duration).not.toBe('');
  });

  it('reports a provider switch as its own row naming the provider and model', () => {
    const process = implementationSessionProcess(
      cell('impl', 'running'),
      tl([
        segment({ id: 1 }),
        segment({
          id: 2,
          reason: 'switch',
          provider: 'codex',
          model: 'gpt-5.6-sol',
          providerSessionId: 'sess-2',
          startedAt: runAt('13:00'),
        }),
      ]),
      [],
      undefined,
      undefined,
      NOW,
    );
    const switched = rows(process).find((r) => r.label === 'switch');
    expect(switched).toBeDefined();
    // A switch is not progress: it carries no status node beyond the shared note.
    expect(switched!.status).toBe('note');
    expect(switched!.detail).toBe('Codex · GPT-5.6 Sol');
    // The relationship marker is STRUCTURAL: the webview draws the arrow from
    // `connector`, never from parsing the label.
    expect(switched!.connector).toBe('switch');
  });

  it('keeps repeated phase events chronological, interleaved with switches', () => {
    const process = implementationSessionProcess(
      cell('impl', 'running'),
      tl([
        segment({ id: 1 }),
        segment({
          id: 2,
          reason: 'switch',
          provider: 'codex',
          model: 'gpt-5.6-sol',
          providerSessionId: 'sess-2',
          startedAt: runAt('12:30'),
        }),
      ]),
      [
        mark('research', runAt('12:10'), { implementationRunId: 1 }),
        mark('plan', runAt('12:20'), { implementationRunId: 1 }),
        mark('research', runAt('12:40'), { implementationRunId: 1 }),
      ],
      undefined,
      undefined,
      NOW,
    );
    const timeline = rows(process);
    // A timeline is a log: repeats stay, in the order they happened — unlike
    // `reportedPhases`, which collapses a repeated phase to its first mark.
    expect(timeline.map((r) => r.label)).toEqual([
      'started',
      'research',
      'plan',
      'switch',
      'research',
    ]);
    expect(timeline[1]!.detail).toBe(formatTime(runAt('12:10')));
    expect(timeline[2]!.detail).toBe(formatTime(runAt('12:20')));
    expect(timeline[4]!.detail).toBe(formatTime(runAt('12:40')));
  });

  it('shows the recorded segment as the execution once the run has started', () => {
    const process = implementationSessionProcess(
      cell('impl', 'running'),
      tl([segment({ id: 1, provider: 'claude', model: 'claude-opus-4-8' })]),
      [],
      // Configured identity is present, but the record wins after start.
      { provider: 'codex', model: 'gpt-5.6-sol' },
      undefined,
      NOW,
    );
    expect(process.execution).toEqual({
      provider: 'claude',
      providerLabel: 'Claude Code',
      model: 'claude-opus-4-8',
      modelLabel: 'Opus 4.8',
    });
    expect(process.configuredExecution).toBeUndefined();
  });

  it('shows the configured identity only before anything ran', () => {
    const process = implementationSessionProcess(
      cell('impl', 'pending'),
      null,
      [],
      { provider: 'claude', model: 'claude-opus-4-8' },
      undefined,
      NOW,
    );
    expect(process.status).toBe('pending');
    expect(process.execution).toBeUndefined();
    expect(process.configuredExecution).toEqual({
      provider: 'claude',
      providerLabel: 'Claude Code',
      model: 'claude-opus-4-8',
      modelLabel: 'Opus 4.8',
    });
  });

  it('keeps the configured identity while a prepared launch has no confirmed segment', () => {
    // A launch-prepared run creates timeline evidence (the pending segment)
    // before SessionStart confirms anything, so the old timeline-presence gate
    // suppressed the configured identity in exactly the window it is needed:
    // the row showed neither what karst was configured to run nor what it ran.
    const prepared = implementationSessionProcess(
      cell('impl', 'running'),
      tl([segment({ id: 1, status: 'pending', startedAt: null, providerSessionId: null })]),
      [],
      { provider: 'claude', model: 'claude-opus-4-8' },
      undefined,
      NOW,
    );
    expect(prepared.execution).toBeUndefined();
    expect(prepared.configuredExecution).toEqual({
      provider: 'claude',
      providerLabel: 'Claude Code',
      model: 'claude-opus-4-8',
      modelLabel: 'Opus 4.8',
    });

    // A confirmed segment is recorded execution: it replaces the fallback.
    const confirmed = implementationSessionProcess(
      cell('impl', 'running'),
      tl([segment({ id: 1, status: 'running' })]),
      [],
      { provider: 'claude', model: 'claude-opus-4-8' },
      undefined,
      NOW,
    );
    expect(confirmed.execution).toBeDefined();
    expect(confirmed.configuredExecution).toBeUndefined();
  });

  it('reads a resumed segment as a resumed row naming the provider and model', () => {
    const process = implementationSessionProcess(
      cell('impl', 'running'),
      tl([
        segment({ id: 1 }),
        segment({
          id: 2,
          reason: 'resume',
          provider: 'claude',
          model: 'claude-opus-4-8',
          providerSessionId: 'sess-2',
          startedAt: runAt('14:00'),
        }),
      ]),
      [],
      undefined,
      undefined,
      NOW,
    );
    const timeline = rows(process);
    expect(timeline.map((r) => r.label)).toEqual(['started', 'resumed']);
    expect(timeline[1]!.detail).toBe('Claude Code · Opus 4.8');
    expect(timeline[1]!.connector).toBe('resume');
  });

  it('omits tokens when nothing was measured on a measuring provider — never a zero', () => {
    // Codex sessions can carry measured usage (interactiveUsage true); with no
    // recorded fact the row stays silent — absence of a fact is not zero.
    const none = implementationSessionProcess(
      cell('impl', 'running'),
      tl([segment({ id: 1, provider: 'codex' })]),
      [],
      undefined,
      undefined,
      NOW,
    );
    expect(none.tokens).toBeUndefined();
    const nullSummary = implementationSessionProcess(
      cell('impl', 'running'),
      tl([segment({ id: 1, provider: 'codex' })]),
      [],
      undefined,
      null,
      NOW,
    );
    expect(nullSummary.tokens).toBeUndefined();
  });

  it('renders measured tokens as a TokenUsageView', () => {
    const process = implementationSessionProcess(
      cell('impl', 'running'),
      tl([segment({ id: 1, provider: 'codex' })]),
      [],
      undefined,
      { total: 12_435 },
      NOW,
    );
    expect(process.tokens).toEqual({ state: 'measured', total: '12.4k', exact: '12,435' });
  });

  it('marks the token view estimated when any call fell back to an estimate', () => {
    const process = implementationSessionProcess(
      cell('impl', 'running'),
      tl([segment({ id: 1, provider: 'codex' })]),
      [],
      undefined,
      { total: 12_435, estimatedCalls: 1 },
      NOW,
    );
    expect(process.tokens).toEqual({ state: 'estimated', total: '12.4k', exact: '12,435' });
  });

  it('renders unavailable — never a zero — for a provider with no per-session usage', () => {
    // Claude declares interactiveUsage false (agent/claude.ts): its sessions
    // can never produce a measured token fact, so the row states that absence
    // instead of claiming "0 tokens".
    const process = implementationSessionProcess(
      cell('impl', 'running'),
      tl([segment({ id: 1, provider: 'claude' })]),
      [],
      undefined,
      null,
      NOW,
    );
    expect(process.tokens).toEqual({
      state: 'unavailable',
      title: 'Token usage not available for this provider',
    });
  });

  it('renders unavailable from the configured provider before anything ran', () => {
    // The default provider IS claude: a pending impl shows the truth about the
    // provider karst will launch, not an absent chip.
    const process = implementationSessionProcess(
      cell('impl', 'pending'),
      null,
      [],
      { provider: 'claude', model: 'claude-opus-4-8' },
      undefined,
      NOW,
    );
    expect(process.tokens).toEqual({
      state: 'unavailable',
      title: 'Token usage not available for this provider',
    });
  });

  it('tokenView never claims a zero for a non-interactive provider', () => {
    expect(tokenView({ total: 12_435 }, false)).toEqual({
      state: 'unavailable',
      title: 'Token usage not available for this provider',
    });
    // Default true preserves the measuring-provider reading for callers that
    // carry no capability context (headless gate processes).
    expect(tokenView({ total: 12_435 })).toEqual({
      state: 'measured',
      total: '12.4k',
      exact: '12,435',
    });
  });

  it('keeps legacy impl marks that predate run attribution', () => {
    const process = implementationSessionProcess(
      cell('impl', 'running'),
      tl([segment({ id: 1 })]),
      [mark('research', runAt('12:10'))],
      undefined,
      undefined,
      NOW,
    );
    expect(rows(process).map((r) => r.label)).toEqual(['started', 'research']);
  });

  it('names the full-evidence continuation with the exact reveal count (B9)', () => {
    // handoff §10: a continuation says exactly what it reveals. The REDUCER
    // computes the label on the target; the host's attach closure carries it
    // into the shipped action (state.ts, pinned by its own suite).
    const marks = Array.from({ length: 25 }, (_, i) => mark(`phase ${i}`, runAt('12:05')));
    let label: string | undefined;
    const attach = (target: InsideEvidenceTarget) => {
      if (target.kind === 'open-full-evidence') label = target.label;
      return { actionId: 'snapshot-1:action-1', kind: target.kind as 'open-full-evidence' };
    };
    const process = implementationSessionProcess(
      cell('impl', 'passed'),
      tl([segment({ id: 1, status: 'closed', endedAt: runAt('12:20') })]),
      marks,
      undefined,
      undefined,
      NOW,
      attach,
    );
    // 25 marks + the started row = 26 events; TIMELINE_LIMIT is 20.
    expect(process.action).toMatchObject({ kind: 'open-full-evidence' });
    expect(label).toBe('Show 6 more');
  });

  it('ignores marks from other stages, other runs, and segments that never started', () => {
    const process = implementationSessionProcess(
      cell('impl', 'running'),
      tl([
        segment({ id: 1 }),
        segment({
          id: 2,
          reason: 'switch',
          provider: 'codex',
          model: 'gpt-5.6-sol',
          providerSessionId: null,
          startedAt: null,
        }),
      ]),
      [
        mark('research', runAt('12:10'), { stageKey: 'uat', implementationRunId: 1 }),
        mark('plan', runAt('12:20'), { implementationRunId: 99 }),
      ],
      undefined,
      undefined,
      NOW,
    );
    // A prepared launch that never confirmed is not an event; the uat mark is
    // not impl evidence; the run-99 mark belongs to another implementation.
    expect(rows(process).map((r) => r.label)).toEqual(['started']);
  });

  it('bounds the timeline and names the remainder', () => {
    const marks = Array.from({ length: 25 }, (_, i) =>
      mark(`phase-${i}`, runAt(`12:${String(i).padStart(2, '0')}`), { implementationRunId: 1 }),
    );
    const process = implementationSessionProcess(
      cell('impl', 'running'),
      tl([segment({ id: 1 })]),
      marks,
      undefined,
      undefined,
      NOW,
    );
    const timeline = rows(process);
    // 25 phase events + the start row, capped at the timeline limit: 20 shown
    // plus the one remainder row naming the 6 withheld.
    expect(timeline.length).toBe(21);
    expect(timeline.at(-1)).toMatchObject({ label: 'more', status: 'note' });
    expect(timeline.at(-1)!.detail).toContain('6');
  });
});
