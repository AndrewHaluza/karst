import { describe, it, expect } from 'vitest';
import { type StageStatus } from '../types.js';
import type { StepperCell } from '../stepper.js';
import { scopeProcesses, uatProcesses, reviewProcesses, shipProcesses, doneReceipt, implementationSessionProcess, type DoneReceiptView } from './index.js';
import { formatTime, type EvidenceRow } from './types.js';

const NOW = '2026-07-20T12:30:00.000Z';

const worktree = (repo: string, branch: string, createdAt: string | null = null) => ({
  ticketId: 1,
  repo,
  repoDisplay: repo,
  path: `/wt/${repo}`,
  branch,
  baseRef: 'main',
  depsMode: 'link' as const,
  createdAt,
  launchable: false,
});

function prefillRun(over: Partial<import('../../store/processRuns.js').ProcessRun> = {}) {
  return {
    id: 1,
    ticketId: 1,
    stageKey: 'scope' as const,
    processId: 'prefill',
    attempt: 0,
    stageRunId: null,
    agentName: null,
    provider: 'claude',
    model: 'claude-opus-4-8',
    pid: null,
    status: 'passed' as const,
    resultKind: null,
    artifactPath: null,
    startedAt: '2026-07-20T11:30:00.000Z',
    endedAt: '2026-07-20T11:31:00.000Z',
    ...over,
  };
}

describe('scopeProcesses', () => {
  function scopeCell(status: StageStatus, extra: Partial<StepperCell> = {}): StepperCell {
    return { stageKey: 'scope', status, ...extra };
  }

  // 869egdr2u-fu2: `confirmScope` creates the worktrees and passes the stage in
  // one act, so a scope cell may carry an END and no START. Dating the rows off
  // `startedAt` alone dropped every scope timestamp on exactly the tickets that
  // took the ordinary path.
  describe('dates its rows from the scope run even when only its end was stamped', () => {
    const endedOnly = scopeCell('passed', { endedAt: '2026-07-20T12:10:00.000Z' });

    it('stamps the hot-set row and each selected service', () => {
      const [hotSet] = scopeProcesses(endedOnly, ['api'], [], NOW);
      expect(hotSet!.time).toBe(formatTime('2026-07-20T12:10:00.000Z'));
      const rows = (hotSet!.evidence as { rows: readonly EvidenceRow[] }).rows;
      expect(rows[0]).toMatchObject({ label: 'api', time: formatTime('2026-07-20T12:10:00.000Z') });
    });

    it('stamps the worktrees row, and each worktree from its own record when it has one', () => {
      const [, worktrees] = scopeProcesses(
        endedOnly,
        ['api'],
        [worktree('api', 'karst/t-1', '2026-07-20T12:09:00.000Z'), worktree('web', 'karst/t-1')],
        NOW,
      );
      expect(worktrees!.time).toBe(formatTime('2026-07-20T12:10:00.000Z'));
      const rows = (worktrees!.evidence as { rows: readonly EvidenceRow[] }).rows;
      expect(rows[0]!.time).toBe(formatTime('2026-07-20T12:09:00.000Z'));
      expect(rows[1]!.time).toBe(formatTime('2026-07-20T12:10:00.000Z'));
    });

    it('states no time at all for a scope run that recorded neither stamp', () => {
      const [hotSet] = scopeProcesses(scopeCell('pending'), ['api'], [], NOW);
      expect(hotSet!.time).toBeUndefined();
      expect((hotSet!.evidence as { rows: readonly EvidenceRow[] }).rows[0]!.time).toBeUndefined();
    });
  });

  const ran = scopeCell('passed', { startedAt: NOW, endedAt: NOW });

  it('emits exactly two process rows — hot-set then worktrees — whatever the repo count', () => {
    const many = scopeProcesses(
      ran,
      ['api', 'web', 'db'],
      [
        worktree('api', 'karst/t-1'),
        worktree('web', 'karst/t-1'),
        worktree('db', 'karst/t-1'),
      ],
      NOW,
    );
    expect(many.map((p) => p.id)).toEqual(['hot-set', 'worktrees']);

    const one = scopeProcesses(ran, ['api'], [worktree('api', 'karst/t-1')], NOW);
    expect(one.map((p) => p.id)).toEqual(['hot-set', 'worktrees']);
  });

  it('carries the whole hot set as one count on one row, not a row per repo', () => {
    const processes = scopeProcesses(
      ran,
      ['api', 'web', 'db'],
      [
        worktree('api', 'karst/t-1'),
        worktree('web', 'karst/t-1'),
        worktree('db', 'karst/t-1'),
      ],
      NOW,
    );
    const hotSet = processes[0]!;
    expect(hotSet.id).toBe('hot-set');
    expect(hotSet.status).toBe('pass');
    expect(hotSet.detail).toContain('3');
    expect(hotSet.detail).toContain('validated');
  });

  it('reports each created worktree as a detail row on the single worktrees process', () => {
    const processes = scopeProcesses(
      ran,
      ['api', 'web'],
      [worktree('api', 'karst/t-1'), worktree('web', 'karst/t-2')],
      NOW,
    );
    const worktrees = processes[1]!;
    expect(worktrees.id).toBe('worktrees');
    expect(worktrees.evidence).toMatchObject({ kind: 'rows' });
    const evidence = worktrees.evidence as { kind: 'rows'; rows: readonly EvidenceRow[] };
    expect(evidence.rows.map((r) => r.label)).toEqual(['worktree', 'worktree']);
    expect(evidence.rows[0]!.status).toBe('pass');
    expect(evidence.rows[0]!.detail).toBe('api · karst/t-1');
    expect(evidence.rows[1]!.detail).toBe('web · karst/t-2');
  });

  it('bounds the worktree detail and names the remainder', () => {
    const repos = Array.from({ length: 12 }, (_, i) => `repo-${i}`);
    const processes = scopeProcesses(
      ran,
      repos,
      repos.map((r) => worktree(r, 'karst/t-1')),
      NOW,
    );
    const evidence = processes[1]!.evidence as { kind: 'rows'; rows: readonly EvidenceRow[] };
    // 8 detail rows, then one row naming the 4 withheld.
    expect(evidence.rows.length).toBe(9);
    expect(evidence.rows.at(-1)!.label).toBe('more');
    expect(evidence.rows.at(-1)!.status).toBe('note');
    expect(evidence.rows.at(-1)!.detail).toContain('4');
  });

  it('reads pending before scope runs, naming the configured hot set', () => {
    const processes = scopeProcesses(scopeCell('pending'), ['api', 'web'], [], NOW);
    const hotSet = processes[0]!;
    const worktrees = processes[1]!;
    expect(hotSet.status).toBe('pending');
    expect(hotSet.detail).toContain('to validate');
    expect(worktrees.status).toBe('pending');
    const evidence = worktrees.evidence as { kind: 'rows'; rows: readonly EvidenceRow[] };
    expect(evidence.rows).toEqual([]);
  });

  it('states when the scope hot set started', () => {
    const processes = scopeProcesses(
      scopeCell('passed', {
        startedAt: '2026-07-20T12:00:00.000Z',
        endedAt: '2026-07-20T12:02:00.000Z',
      }),
      ['api', 'web'],
      [worktree('api', 'karst/t-1')],
      NOW,
    );
    const hotSet = processes[0]!;
    expect(hotSet.time).toBe(formatTime('2026-07-20T12:00:00.000Z'));
    expect(hotSet.duration).toBe('2m 0s');
    expect(hotSet.durationExact).toBe('120.000s');
  });

  it('dates the worktrees row too — every scope row carries its stamp', () => {
    // 869egdr2u-fu1: the worktrees row was the one scope row without a
    // timestamp; every scope process must date from the same scope run.
    const processes = scopeProcesses(
      scopeCell('passed', {
        startedAt: '2026-07-20T12:00:00.000Z',
        endedAt: '2026-07-20T12:02:00.000Z',
      }),
      ['api', 'web'],
      [worktree('api', 'karst/t-1'), worktree('web', 'karst/t-1')],
      NOW,
    );
    const worktrees = processes[1]!;
    expect(worktrees.time).toBe(formatTime('2026-07-20T12:00:00.000Z'));
    expect(worktrees.duration).toBe('2m 0s');
    expect(worktrees.durationExact).toBe('120.000s');
  });

  it('describes the worktrees row in every state, never an empty cell', () => {
    // 869egdr2u-fu1: the row previously had no description at all.
    const ran = scopeProcesses(
      scopeCell('passed', {
        startedAt: '2026-07-20T12:00:00.000Z',
        endedAt: '2026-07-20T12:02:00.000Z',
      }),
      ['api', 'web'],
      [worktree('api', 'karst/t-1'), worktree('web', 'karst/t-1')],
      NOW,
    )[1]!;
    expect(ran.detail).toBe('2 worktrees created');

    const pending = scopeProcesses(scopeCell('pending'), ['api'], [], NOW)[1]!;
    expect(pending.detail).toBe('not created yet');
    expect(pending.count).toBeUndefined();
  });

  it('notes honestly when scope ran but created no worktrees', () => {
    const processes = scopeProcesses(ran, [], [], NOW);
    const worktrees = processes[1]!;
    expect(worktrees.status).toBe('note');
    expect(worktrees.detail).toContain('no worktrees');
  });

  it('dates each expanded hot-set row from the scope run that selected it', () => {
    const processes = scopeProcesses(
      scopeCell('passed', { startedAt: '2026-07-20T12:00:00.000Z', endedAt: NOW }),
      ['api', 'web'],
      [],
      NOW,
    );
    const evidence = processes[0]!.evidence as { kind: 'rows'; rows: readonly EvidenceRow[] };
    expect(evidence.rows[0]!.time).toBe(formatTime('2026-07-20T12:00:00.000Z'));
    expect(evidence.rows[1]!.time).toBe(formatTime('2026-07-20T12:00:00.000Z'));
  });

  it('dates each worktree row from its own registration stamp when recorded', () => {
    const processes = scopeProcesses(
      ran,
      ['api'],
      [
        worktree('api', 'karst/t-1', '2026-07-20T12:01:00.000Z'),
        worktree('web', 'karst/t-1'), // pre-v13 row: no stamp
      ],
      NOW,
    );
    const evidence = processes[1]!.evidence as { kind: 'rows'; rows: readonly EvidenceRow[] };
    expect(evidence.rows[0]!.time).toBe(formatTime('2026-07-20T12:01:00.000Z'));
    // An unrecorded stamp falls back to the scope stage's start; a scope that
    // never ran leaves the row undated rather than inventing a time.
    expect(evidence.rows[1]!.time).toBe(formatTime(NOW));
  });

  describe('the AI prefill process (Task 10b)', () => {
    it('appears FIRST when an analysis ran, with its AI identity and recorded spend', () => {
      const processes = scopeProcesses(
        scopeCell('pending'),
        ['api'],
        [],
        NOW,
        [prefillRun()],
        { total: 4800, input: 4000, output: 800 },
      );
      expect(processes.map((p) => p.id)).toEqual(['prefill', 'hot-set', 'worktrees']);
      const prefill = processes[0]!;
      expect(prefill.kind).toBe('prefill');
      expect(prefill.status).toBe('pass');
      expect(prefill.detail).toContain('prompt improved');
      expect(prefill.execution).toMatchObject({ provider: 'claude', model: 'claude-opus-4-8' });
      expect(prefill.tokens?.state).toBe('measured');
      expect(prefill.time).toBe(formatTime('2026-07-20T11:30:00.000Z'));
    });

    it('reads a failed analysis as fail — never a pass', () => {
      const processes = scopeProcesses(
        scopeCell('pending'),
        ['api'],
        [],
        NOW,
        [prefillRun({ status: 'failed', resultKind: 'execution-failed' })],
      );
      const prefill = processes[0]!;
      expect(prefill.status).toBe('fail');
      expect(prefill.detail).toContain('failed');
    });

    it('reads an interrupted analysis as a note, never a verdict', () => {
      const processes = scopeProcesses(scopeCell('pending'), ['api'], [], NOW, [
        prefillRun({ status: 'interrupted', endedAt: null }),
      ]);
      const prefill = processes[0]!;
      expect(prefill.status).toBe('note');
      expect(prefill.detail).toContain('interrupted');
    });

    it('omits the row entirely when no analysis was ever recorded', () => {
      const processes = scopeProcesses(scopeCell('pending'), ['api'], [], NOW, []);
      expect(processes.map((p) => p.id)).toEqual(['hot-set', 'worktrees']);
    });

    it('prefers the latest analysis run over a superseded one', () => {
      const processes = scopeProcesses(scopeCell('pending'), ['api'], [], NOW, [
        prefillRun({ id: 1, status: 'stale', endedAt: null }),
        prefillRun({ id: 2, status: 'passed' }),
      ]);
      expect(processes[0]!.status).toBe('pass');
    });
  });
});

describe('quality process reducers (re-exported)', () => {
  const input = {
    cell: { stageKey: 'uat' as const, status: 'passed' as const },
    gateRuns: [],
    findings: [],
    uatFindings: [],
    processRuns: [],
    rounds: [],
    services: ['web'],
    now: NOW,
  };

  it('uatProcesses emits the registry order', () => {
    expect(uatProcesses(input).map((p) => p.id)).toEqual(['gates', 'services', 'tester']);
  });

  it('reviewProcesses emits the registry order', () => {
    expect(reviewProcesses({ ...input, cell: { stageKey: 'review' as const, status: 'passed' as const } }).map((p) => p.id)).toEqual(['gates', 'services', 'review']);
  });
});

describe('ship and done reducers (re-exported)', () => {
  it('exposes shipProcesses and doneReceipt from the index', () => {
    expect(typeof shipProcesses).toBe('function');
    expect(typeof doneReceipt).toBe('function');
  });

  it('reads ship landing through the index boundary from literal merged status only', () => {
    const merge = shipProcesses({
      cell: { stageKey: 'ship', status: 'passed' },
      evidence: { run: undefined, repos: {} },
      prs: [{ repo: 'api', number: 12, status: 'open', mergedAt: NOW }],
      mergeChecks: [],
      now: NOW,
    }).find((p) => p.id === 'merge')!;
    expect(merge.status).toBe('wait');
  });

  it('keeps the done receipt pending of delivery through the index boundary', () => {
    const view = doneReceipt({
      stageCurrent: 'done',
      ship: { run: undefined, repos: {} },
      prs: [{ repo: 'api', number: 12, status: 'unknown', mergedAt: NOW }],
      mergeChecks: [],
      gateRuns: [],
      rounds: [],
      tokens: null,
      roles: [],
      now: NOW,
      stages: [],
    }) as Extract<DoneReceiptView, { status: 'complete' }>;
    expect(view.delivered).toEqual({ repos: 0, prs: 0, commits: 0 });
  });
});

describe('implementationSessionProcess (index re-export)', () => {
  const runAt = (t: string) => `2026-07-20T${t}:00.000Z`;

  const prepared: import('../../store/implementationRuns.js').ImplementationTimeline = {
    run: {
      id: 1,
      ticketId: 1,
      processRunId: 1,
      attempt: 0,
      status: 'running',
      startedAt: runAt('12:00'),
      endedAt: null,
    },
    segments: [
      {
        id: 1,
        implementationRunId: 1,
        provider: 'claude',
        model: 'claude-opus-4-8',
        providerSessionId: null,
        reason: null,
        status: 'pending',
        launchIntentId: 1,
        startedAt: null,
        endedAt: null,
      },
    ],
  };

  it('preserves configured identity through the index boundary until a confirmed segment exists', () => {
    const before = implementationSessionProcess(
      { stageKey: 'impl', status: 'running' },
      prepared,
      [],
      { provider: 'claude', model: 'claude-opus-4-8' },
      undefined,
      NOW,
    );
    expect(before.execution).toBeUndefined();
    expect(before.configuredExecution).toMatchObject({ provider: 'claude' });

    const confirmed = implementationSessionProcess(
      { stageKey: 'impl', status: 'running' },
      {
        ...prepared,
        segments: [{ ...prepared.segments[0]!, status: 'running', startedAt: runAt('12:00') }],
      },
      [],
      { provider: 'claude', model: 'claude-opus-4-8' },
      undefined,
      NOW,
    );
    expect(confirmed.execution).toMatchObject({ provider: 'claude' });
    expect(confirmed.configuredExecution).toBeUndefined();
  });
});
