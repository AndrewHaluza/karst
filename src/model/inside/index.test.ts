import { describe, it, expect } from 'vitest';
import { type StageStatus } from '../types.js';
import type { StepperCell } from '../stepper.js';
import { scopeProcesses, uatProcesses, reviewProcesses, shipProcesses, doneReceipt, implementationSessionProcess, type DoneReceiptView } from './index.js';
import { formatTime, type EvidenceRow } from './types.js';

const NOW = '2026-07-20T12:30:00.000Z';

const worktree = (repo: string, branch: string) => ({
  ticketId: 1,
  repo,
  repoDisplay: repo,
  path: `/wt/${repo}`,
  branch,
  baseRef: 'main',
  depsMode: 'link' as const,
});

describe('scopeProcesses', () => {
  function scopeCell(status: StageStatus, extra: Partial<StepperCell> = {}): StepperCell {
    return { stageKey: 'scope', status, ...extra };
  }

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
    expect(hotSet.count).toBe('3');
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
    expect(hotSet.count).toBe('2');
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
    // The worktrees row records no start of its own — it must not carry one.
    expect(processes[1]!.time).toBeUndefined();
    expect(processes[1]!.durationExact).toBeUndefined();
  });

  it('notes honestly when scope ran but created no worktrees', () => {
    const processes = scopeProcesses(ran, [], [], NOW);
    const worktrees = processes[1]!;
    expect(worktrees.status).toBe('note');
    expect(worktrees.detail).toContain('no worktrees');
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
