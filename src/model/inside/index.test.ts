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
    // review/uat are exempt: their gate list is static, so they show it pending
    // even before the stage runs (covered in gates.test.ts) — every other stage
    // has nothing enumerable yet, so it falls back to the blurb.
    const all = build({});
    for (const key of STAGE_KEYS) {
      if (key === 'review' || key === 'uat') continue;
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

    it('has nothing to show when no worktree was created', () => {
      expect(build({ scope: 'running' }).scope.ops).toEqual([]);
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
    expect(all.uat.ops.map((o) => o.name)).toContain('test');
    expect(all.review.ops.map((o) => o.name)).toContain('lint');
    expect(all.impl.ops.map((o) => o.name)).toContain('phases');
    expect(all.fix.ops.map((o) => o.name)).toContain('returns');
  });
});
