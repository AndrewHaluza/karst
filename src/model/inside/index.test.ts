import { describe, it, expect } from 'vitest';
import { STAGE_KEYS, type StageKey, type StageStatus } from '../types.js';
import { buildStepper, type StepperStageRow } from '../stepper.js';
import { buildStageInside, type StageInsideInput } from './index.js';

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

  describe('merge', () => {
    // The stage parks as pending the moment it is entered, so status alone
    // cannot separate "not reached yet" from "reached, nothing to land".
    const entered = (rows: StepperStageRow[] = []) =>
      buildStepper([{ stageKey: 'merge', status: 'pending', startedAt: NOW }, ...rows]);

    it('says nothing before the stage is reached — the blurb answers instead', () => {
      expect(build({ ship: 'pending' }).merge.ops).toEqual([]);
    });

    it('states outright that a ticket with no PR had nothing to land', () => {
      expect(build({}, { stepper: entered() }).merge.ops).toEqual([
        {
          status: 'note',
          name: 'merge',
          detail: 'nothing was delivered — no pull request to merge',
          duration: '',
        },
      ]);
    });

    it('marks a landed PR passed and one still open as waiting', () => {
      const prs = [
        { ticketId: 1, repo: 'api', number: 12, url: 'https://x/12', status: 'merged', mergedAt: NOW },
        { ticketId: 1, repo: 'web', number: 13, url: 'https://x/13', status: 'open' },
      ];
      expect(build({}, { stepper: entered(), prs }).merge.ops).toEqual([
        { status: 'pass', name: 'merged', detail: 'api #12', duration: '' },
        { status: 'wait', name: 'open', detail: 'web #13 · not merged yet', duration: '' },
      ]);
    });

    // The one row on this strip a person has to act on.
    it('fails the row for a repo whose branch no longer merges cleanly', () => {
      const prs = [{ ticketId: 1, repo: 'api', number: 12, url: 'https://x/12', status: 'open' }];
      const ops = build({}, {
        stepper: entered(),
        prs,
        mergeChecks: [check('api', { state: 'conflicted', files: ['src/a.ts'] })],
      }).merge.ops;
      expect(ops).toHaveLength(1);
      expect(ops[0]!.status).toBe('fail');
      expect(ops[0]!.name).toBe('conflict');
      expect(ops[0]!.detail).toContain('api #12');
    });

    // A repo re-shipped after a merge carries both rows; answering twice for one
    // repo is what the ship strip does (a log of what it did) and what this strip
    // must not (an answer to "has this landed").
    it('reports one row per repo, for the current PR', () => {
      const prs = [
        { ticketId: 1, repo: 'api', number: 12, url: 'https://x/12', status: 'merged', mergedAt: NOW },
        { ticketId: 1, repo: 'api', number: 14, url: 'https://x/14', status: 'open' },
      ];
      expect(build({}, { stepper: entered(), prs }).merge.ops).toEqual([
        { status: 'wait', name: 'open', detail: 'api #14 · not merged yet', duration: '' },
      ]);
    });

    it('names the repo the way every other surface does (display path)', () => {
      const prs = [
        {
          ticketId: 1,
          repo: '/abs/repo/api',
          repoDisplay: 'api',
          number: 12,
          url: 'https://x/12',
          status: 'open',
        },
      ];
      expect(build({}, { stepper: entered(), prs }).merge.ops[0]!.detail).toBe(
        'api #12 · not merged yet',
      );
    });
  });

  describe('ship', () => {
    it('reports one row per PR it opened', () => {
      const prs = [
        { ticketId: 1, repo: 'api', number: 12, url: 'https://x/12', status: 'open' },
        { ticketId: 1, repo: 'web', number: 13, url: 'https://x/13', status: 'open' },
      ];
      const ops = build({ ship: 'passed' }, { prs }).ship.ops;
      expect(ops).toHaveLength(2);
      expect(ops[0]).toMatchObject({ name: 'pr', status: 'pass' });
      expect(ops[0]!.detail).toContain('api');
      expect(ops[0]!.detail).toContain('#12');
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

    // A ticket that shipped before merge checks existed, or whose check never got
    // written, must render as it always did. Silence is the honest reading of "we
    // have not checked" — inventing a clean row would be the exact failure this
    // feature exists to prevent.
    it('shows no merge row for a repo that was never checked', () => {
      const prs = [{ ticketId: 1, repo: 'api', number: 12, url: 'https://x/12', status: 'open' }];
      const ops = build({ ship: 'passed' }, { prs }).ship.ops;
      expect(ops).toHaveLength(1);
      expect(ops.some((o) => o.name === 'merge')).toBe(false);
    });

    it('reports a clean merge check beside its PR', () => {
      const prs = [{ ticketId: 1, repo: 'api', number: 12, url: 'https://x/12', status: 'open' }];
      const ops = build({ ship: 'passed' }, { prs, mergeChecks: [check('api')] }).ship.ops;

      expect(ops).toHaveLength(2);
      expect(ops[1]).toMatchObject({ name: 'merge', status: 'pass' });
      expect(ops[1]!.detail).toContain('clean');
    });

    // The row reads `fail` inside a stage that PASSED, deliberately: the ship
    // succeeded — a PR exists — and the merge is a separate fact about it.
    it('reports a conflict as a failed row with the conflicting files', () => {
      const prs = [{ ticketId: 1, repo: 'api', number: 12, url: 'https://x/12', status: 'open' }];
      const mergeChecks = [
        check('api', { state: 'conflicted' as const, files: ['src/a.ts', 'src/b.ts'] }),
      ];

      const strip = build({ ship: 'passed' }, { prs, mergeChecks }).ship;

      expect(strip.dot).toBe('done'); // the stage still passed
      expect(strip.ops[1]).toMatchObject({ name: 'merge', status: 'fail' });
      expect(strip.ops[1]!.detail).toContain('src/a.ts');
      expect(strip.ops[1]!.detail).toContain('src/b.ts');
    });

    // `note` exists for a fact karst cannot honestly dress as a verdict. Calling
    // an unanswered check a pass is precisely the lie being prevented.
    it('reports an unknown check as a note carrying git’s own reason — never a pass', () => {
      const prs = [{ ticketId: 1, repo: 'api', number: 12, url: 'https://x/12', status: 'open' }];
      const mergeChecks = [
        check('api', { state: 'unknown' as const, reason: "fatal: couldn't find remote ref main" }),
      ];

      const ops = build({ ship: 'passed' }, { prs, mergeChecks }).ship.ops;

      expect(ops[1]).toMatchObject({ name: 'merge', status: 'note' });
      expect(ops[1]!.status).not.toBe('pass');
      expect(ops[1]!.detail).toContain("couldn't find remote ref main");
    });

    it('pairs each check with its own repo', () => {
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
        ['merge', 'fail'],
        ['pr', 'pass'],
        ['merge', 'pass'],
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
