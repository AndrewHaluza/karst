import { describe, it, expect } from 'vitest';
import { STAGE_KEYS, type StageKey, type StageStatus } from '../types.js';
import { buildStepper, type StepperCell, type StepperStageRow } from '../stepper.js';
import { buildStageInside, scopeProcesses, uatProcesses, reviewProcesses, shipProcesses, doneReceipt, implementationSessionProcess, type StageInsideInput } from './index.js';
import type { EvidenceRow } from './types.js';

const NOW = '2026-07-20T12:30:00.000Z';

function build(
  stages: Partial<Record<StageKey, StageStatus>>,
  over: Partial<StageInsideInput> = {},
) {
  const rows: StepperStageRow[] = Object.entries(stages).map(([stageKey, status]) => ({
    stageKey: stageKey as StageKey,
    status: status as StageStatus,
  }));
  return buildStageInside({
    stepper: buildStepper(rows),
    gateRuns: [],
    findings: [],
    worktrees: [],
    prs: [],
    session: { sessionId: null, agentState: null, model: null },
    selectedRepos: [],
    phases: [],
    marks: [],
    fixAttempts: 0,
    now: NOW,
    ...over,
  });
}

const check = (
  repo: string,
  over: Partial<import('../../store/mergeChecks.js').MergeCheckRow> = {},
) => ({
  ticketId: 1,
  repo,
  state: 'clean' as const,
  files: [] as readonly string[],
  reason: null,
  headSha: 'aaa1111',
  baseSha: 'bbb2222',
  baseRef: 'main',
  checkedAt: NOW,
  ...over,
});

const worktree = (repo: string, branch: string) => ({
  ticketId: 1,
  repo,
  repoDisplay: repo,
  path: `/wt/${repo}`,
  branch,
  baseRef: 'main',
  depsMode: 'link' as const,
});

describe('buildStageInside', () => {
  it('gives every stage a strip, so no stage can be selected into a hole', () => {
    const all = build({});
    for (const key of STAGE_KEYS) {
      expect(all[key], `missing strip: ${key}`).toBeDefined();
      expect(all[key].stageKey).toBe(key);
    }
  });

  it('gives a stage with nothing predefined a blurb instead of empty rows', () => {
    // Empty operation rows would imply karst tried something and got nothing.
    // review/uat/impl/fix are exempt: each has a static, already-known-in-advance
    // list (gate specs; declared workflow phases; the fix-loop's return info) that
    // it shows before the stage runs (covered in gates.test.ts/agent.test.ts) —
    // scope/ship join them once a repo is actually selected (see their own
    // describe blocks); with nothing selected yet, they too fall back to blurb.
    const all = build({});
    for (const key of STAGE_KEYS) {
      if (key === 'review' || key === 'uat' || key === 'impl' || key === 'fix') continue;
      expect(all[key].ops, `${key} invented rows`).toEqual([]);
      expect(all[key].blurb.length, `${key} has no blurb`).toBeGreaterThan(0);
    }
  });

  describe('scope', () => {
    it('reports the hot set and one row per worktree it created', () => {
      const all = build(
        { scope: 'passed' },
        { worktrees: [worktree('api', 'karst/t-1'), worktree('web', 'karst/t-1')], selectedRepos: ['api', 'web'] },
      );
      const ops = all.scope.ops;
      expect(ops[0]).toMatchObject({ name: 'hot set', status: 'pass' });
      expect(ops[0]!.detail).toContain('2');
      expect(ops.filter((o) => o.name === 'worktree')).toHaveLength(2);
      expect(ops[1]!.detail).toContain('api');
      expect(ops[1]!.detail).toContain('karst/t-1');
    });

    it('has nothing to show when no worktree was created and no repo is selected yet', () => {
      expect(build({ scope: 'running' }).scope.ops).toEqual([]);
    });

    it('shows a pending worktree row per hot repo before scope has run', () => {
      const ops = build(
        { scope: 'pending' },
        { selectedRepos: ['api', 'web'] },
      ).scope.ops;
      expect(ops.map((o) => [o.name, o.status])).toEqual([
        ['hot set', 'pending'],
        ['worktree', 'pending'],
        ['worktree', 'pending'],
      ]);
      expect(ops[0]!.detail).toContain('2');
      expect(ops[1]!.detail).toContain('api');
      expect(ops[2]!.detail).toContain('web');
    });
  });

  describe('ship', () => {
    // Every PR row is a log entry (`pr`); the LANDING row answering "has this
    // repo landed" is a separate fact, appended after all the pr rows —
    // covered on its own below. Filtering to `pr`-named ops isolates the one
    // thing this test is about.
    it('reports one pr row per PR it opened', () => {
      const prs = [
        { ticketId: 1, repo: 'api', number: 12, url: 'https://x/12', status: 'open' },
        { ticketId: 1, repo: 'web', number: 13, url: 'https://x/13', status: 'open' },
      ];
      const ops = build({ ship: 'passed' }, { prs }).ship.ops;
      const prOps = ops.filter((o) => o.name === 'pr');
      expect(prOps).toHaveLength(2);
      expect(prOps[0]).toMatchObject({ name: 'pr', status: 'pass' });
      expect(prOps[0]!.detail).toContain('api');
      expect(prOps[0]!.detail).toContain('#12');
    });

    // The ship strip names the same directory the worktree rows do, so it must
    // honor the one path-display preference rather than printing a raw path.
    it('names the repo by its DISPLAY path and carries the PR’s from-to branches', () => {
      const prs = [
        {
          ticketId: 1,
          repo: '/Users/nd/Work/projects/karst',
          repoDisplay: './karst',
          number: 12,
          url: 'https://x/12',
          status: 'open',
          headRef: 'karst/feat/ship',
          baseRef: 'develop',
        },
      ];
      const ops = build({ ship: 'passed' }, { prs }).ship.ops;
      expect(ops[0]!.detail).toBe('./karst #12 · karst/feat/ship → develop');
      expect(ops[0]!.detail).not.toContain('/Users/nd');
    });

    it('says merged on the row once the PR carries a merge stamp', () => {
      const prs = [
        {
          ticketId: 1,
          repo: 'api',
          number: 12,
          url: 'https://x/12',
          status: 'merged',
          headRef: 'karst/feat/ship',
          baseRef: 'develop',
          mergedAt: '2026-07-28T09:30:00Z',
        },
      ];
      expect(build({ ship: 'passed' }, { prs }).ship.ops[0]!.detail).toContain('merged');
    });

    // Unprobed metadata must render exactly as it did before the metadata existed
    // — no empty arrow, no dangling separator.
    it('renders a PR with no metadata as just its repo and number', () => {
      const prs = [{ ticketId: 1, repo: 'api', number: 12, url: 'https://x/12', status: 'open' }];
      expect(build({ ship: 'passed' }, { prs }).ship.ops[0]!.detail).toBe('api #12');
    });

    // Landing is read off `pr.status`/`pr.mergedAt`, never off the merge check
    // — a check is consulted only for a conflict's detail. So a repo with no
    // check on file (a ticket shipped before merge checks existed, or one
    // whose check never got written) must still get an honest "open, not
    // merged yet" landing row rather than silence — inventing a clean-looking
    // absence would be the exact failure this feature exists to prevent.
    it('reports an open landing row for a repo that was never checked', () => {
      const prs = [{ ticketId: 1, repo: 'api', number: 12, url: 'https://x/12', status: 'open' }];
      const ops = build({ ship: 'passed' }, { prs }).ship.ops;
      expect(ops.map((o) => [o.name, o.status])).toEqual([
        ['pr', 'pass'],
        ['open', 'wait'],
      ]);
      expect(ops[1]!.detail).toContain('not merged yet');
    });

    // A clean check does not, by itself, mean landed — only the PR's own
    // status/mergedAt says that. An open PR with a clean check is still just
    // open: the check is future information about whether it WOULD merge
    // cleanly, not a report that it already has.
    it('still reports open, not merged yet, when the merge check reads clean', () => {
      const prs = [{ ticketId: 1, repo: 'api', number: 12, url: 'https://x/12', status: 'open' }];
      const ops = build({ ship: 'passed' }, { prs, mergeChecks: [check('api')] }).ship.ops;
      expect(ops[1]).toMatchObject({ name: 'open', status: 'wait' });
    });

    // Once the PR itself reads merged, the landing row says so — regardless of
    // what the merge check (a pre-merge probe) last recorded for that repo.
    it('reports a merged landing row once the PR carries a merge stamp', () => {
      const prs = [
        {
          ticketId: 1,
          repo: 'api',
          number: 12,
          url: 'https://x/12',
          status: 'merged',
          mergedAt: '2026-07-28T09:30:00Z',
        },
      ];
      const ops = build({ ship: 'passed' }, { prs }).ship.ops;
      expect(ops[1]).toMatchObject({ name: 'merged', status: 'pass' });
      expect(ops[1]!.detail).toContain('api');
      expect(ops[1]!.detail).toContain('#12');
    });

    // The row reads `fail` inside a stage that PASSED, deliberately: the ship
    // succeeded — a PR exists — and the merge is a separate fact about it.
    it('reports a conflict as a failed landing row with the conflicting files', () => {
      const prs = [{ ticketId: 1, repo: 'api', number: 12, url: 'https://x/12', status: 'open' }];
      const mergeChecks = [
        check('api', { state: 'conflicted' as const, files: ['src/a.ts', 'src/b.ts'] }),
      ];

      const strip = build({ ship: 'passed' }, { prs, mergeChecks }).ship;

      expect(strip.dot).toBe('done'); // the stage still passed
      expect(strip.ops[1]).toMatchObject({ name: 'conflict', status: 'fail' });
      expect(strip.ops[1]!.detail).toContain('src/a.ts');
      expect(strip.ops[1]!.detail).toContain('src/b.ts');
    });

    // An `unknown` check (a probe that could not answer) is not a conflict, so
    // it must not read as one — it falls back to the same honest "open, not
    // merged yet" a repo with no check at all gets.
    it('does not read an unresolved merge check as a conflict', () => {
      const prs = [{ ticketId: 1, repo: 'api', number: 12, url: 'https://x/12', status: 'open' }];
      const mergeChecks = [
        check('api', { state: 'unknown' as const, reason: "fatal: couldn't find remote ref main" }),
      ];
      const ops = build({ ship: 'passed' }, { prs, mergeChecks }).ship.ops;
      expect(ops[1]).toMatchObject({ name: 'open', status: 'wait' });
    });

    it('pairs each landing row with its own repo, after every pr row', () => {
      const prs = [
        { ticketId: 1, repo: 'api', number: 12, url: 'https://x/12', status: 'open' },
        { ticketId: 1, repo: 'web', number: 13, url: 'https://x/13', status: 'open' },
      ];
      const mergeChecks = [
        check('api', { state: 'conflicted' as const, files: ['api/x.ts'] }),
        check('web'),
      ];

      const ops = build({ ship: 'passed' }, { prs, mergeChecks }).ship.ops;

      expect(ops.map((o) => [o.name, o.status])).toEqual([
        ['pr', 'pass'],
        ['pr', 'pass'],
        ['conflict', 'fail'],
        ['open', 'wait'],
      ]);
    });

    // `store/prs.ts`'s CURRENT_PR_ORDER: an open PR wins over a merged one, so
    // a repo re-shipped after a merge lands the strip on the branch that is
    // still actually open, not the stale one already landed.
    it('scopes the landing row to the CURRENT PR when a repo has been re-shipped', () => {
      const prs = [
        {
          ticketId: 1,
          repo: 'api',
          number: 11,
          url: 'https://x/11',
          status: 'merged',
          mergedAt: '2026-07-20T09:00:00Z',
        },
        { ticketId: 1, repo: 'api', number: 14, url: 'https://x/14', status: 'open' },
      ];
      const ops = build({ ship: 'passed' }, { prs }).ship.ops;
      const landing = ops.filter((o) => o.name !== 'pr');
      // ONE landing row for the repo, describing the still-open PR — never
      // both, and never the stale merged one.
      expect(landing).toHaveLength(1);
      expect(landing[0]).toMatchObject({ name: 'open', status: 'wait' });
      expect(landing[0]!.detail).toContain('#14');
      expect(landing[0]!.detail).not.toContain('#11');
    });

    // Ship's own work can be entirely done with nothing to land — a ticket
    // whose diff was empty in every hot repo opens no PR at all. That is a
    // genuine pass, not silence, so the strip says so explicitly rather than
    // looking like karst forgot to check.
    it('notes nothing was delivered when ship entered but opened no PR', () => {
      const rows: StepperStageRow[] = [
        { stageKey: 'ship', status: 'passed', startedAt: NOW, endedAt: NOW },
      ];
      const all = buildStageInside({
        stepper: buildStepper(rows),
        gateRuns: [],
        findings: [],
        worktrees: [],
        prs: [],
        session: { sessionId: null, agentState: null, model: null },
        selectedRepos: ['api'],
        phases: [],
        marks: [],
        fixAttempts: 0,
        now: NOW,
      });
      expect(all.ship.ops).toEqual([
        {
          status: 'note',
          name: 'merge',
          detail: 'nothing was delivered — no pull request to merge',
          duration: '',
        },
      ]);
    });

    it('shows a pending pr/merge row per hot repo before ship has run', () => {
      const ops = build(
        { ship: 'pending' },
        { selectedRepos: ['api', 'web'] },
      ).ship.ops;
      expect(ops.map((o) => [o.name, o.status])).toEqual([
        ['pr', 'pending'],
        ['merge', 'pending'],
        ['pr', 'pending'],
        ['merge', 'pending'],
      ]);
      expect(ops[0]!.detail).toContain('api');
      expect(ops[2]!.detail).toContain('web');
    });

    it('has nothing to show before ship when no repo is even selected yet', () => {
      expect(build({ ship: 'pending' }).ship.ops).toEqual([]);
    });

    it('surfaces the real error when ship failed', () => {
      const rows: StepperStageRow[] = [
        { stageKey: 'ship', status: 'failed', verdict: 'push rejected: non-fast-forward' },
      ];
      const all = buildStageInside({
        stepper: buildStepper(rows),
        gateRuns: [],
        findings: [],
        worktrees: [],
        prs: [],
        session: { sessionId: null, agentState: null, model: null },
        selectedRepos: [],
        phases: [],
        marks: [],
        fixAttempts: 0,
        now: NOW,
      });
      expect(all.ship.ops).toEqual([
        {
          status: 'fail',
          name: 'ship',
          detail: 'push rejected: non-fast-forward',
          duration: '',
        },
      ]);
    });
  });

  describe('done', () => {
    it('shows no rows even once reached — arriving is the whole event', () => {
      // The machine stamps started_at === ended_at on a terminal stage, so its
      // duration is structurally zero and any row here would be theatre.
      expect(build({ done: 'passed' }).done.ops).toEqual([]);
    });
  });

  it('routes each stage to the derivation that owns its data', () => {
    const all = build(
      { uat: 'running', review: 'running', impl: 'running', fix: 'running' },
      { session: { sessionId: 'abc', agentState: 'running', model: 'm' } },
    );
    // Neither gate stage has a static list to name — both resolve one per
    // repository at run time — so a running stage with no rows yet says exactly
    // that. Review adds its changes row, which is what tells the two apart here.
    expect(all.uat.ops.map((o) => o.name)).toEqual(['gates']);
    expect(all.review.ops.map((o) => o.name)).toEqual(['gates', 'changes']);
    expect(all.impl.ops.map((o) => o.name)).toContain('phases');
    expect(all.fix.ops.map((o) => o.name)).toContain('returns');
  });
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
