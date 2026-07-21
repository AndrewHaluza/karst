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

  it('gives a stage that has not run a blurb instead of empty rows', () => {
    // Empty operation rows would imply karst tried something and got nothing.
    const all = build({});
    for (const key of STAGE_KEYS) {
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
