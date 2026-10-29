import { describe, it, expect } from 'vitest';
import {
  BASE_RERUN_CAP,
  baseRerunArgv,
  classifyFailures,
  driftNotice,
  failingScreenshots,
  planBaseCheck,
  reportLines,
} from './baseDrift.mjs';

const shot = (project, title, path) => ({
  title,
  tests: [
    {
      projectName: project,
      status: 'unexpected',
      results: [{ attachments: [{ name: `${title}-expected.png`, path }] }],
    },
  ],
});

const report = (...specs) => ({ suites: [{ specs }] });

describe('failingScreenshots', () => {
  it('lists failed screenshot specs with their project and baseline', () => {
    const rep = report(
      shot('dark', 'dashboard', '/repo/tests/visual/__baselines__/dark/dash.png'),
      { title: 'ok', tests: [{ projectName: 'dark', status: 'expected', results: [] }] },
    );
    expect(failingScreenshots(rep, '/repo')).toEqual({
      screenshots: [{ project: 'dark', title: 'dashboard', baseline: 'tests/visual/__baselines__/dark/dash.png' }],
      otherFailures: 0,
    });
  });

  it('counts a failure without an expected image as another failure', () => {
    const rep = report({ title: 'boom', tests: [{ projectName: 'dark', status: 'unexpected', results: [] }] });
    expect(failingScreenshots(rep, '/repo')).toEqual({ screenshots: [], otherFailures: 1 });
  });

  it('walks nested suites', () => {
    const rep = { suites: [{ suites: [{ specs: [shot('light', 'a', '/repo/b.png')] }] }] };
    expect(failingScreenshots(rep, '/repo').screenshots).toHaveLength(1);
  });
});

describe('planBaseCheck', () => {
  const s = (n) => ({ project: 'dark', title: `t${n}`, baseline: `b${n}.png` });
  it('skips when there are no failures to check', () => {
    expect(planBaseCheck({ screenshots: [], otherFailures: 0 }, new Set())).toEqual({ kind: 'skip' });
  });
  it('fails as today when a non-screenshot failure exists', () => {
    expect(planBaseCheck({ screenshots: [s(1)], otherFailures: 1 }, new Set())).toMatchObject({ kind: 'fail' });
  });
  it('fails as today when a failing baseline is one the ticket recorded', () => {
    const plan = planBaseCheck({ screenshots: [s(1), s(2)], otherFailures: 0 }, new Set(['b2.png']));
    expect(plan).toMatchObject({ kind: 'fail' });
    expect(plan.reason).toContain('b2.png');
  });
  it('fails with the wholesale reason above the cap', () => {
    const many = Array.from({ length: BASE_RERUN_CAP + 1 }, (_, i) => s(i));
    const plan = planBaseCheck({ screenshots: many, otherFailures: 0 }, new Set());
    expect(plan.kind).toBe('fail');
    expect(plan.reason).toContain('base likely drifted wholesale');
  });
  it('runs at exactly the cap', () => {
    const many = Array.from({ length: BASE_RERUN_CAP }, (_, i) => s(i));
    expect(planBaseCheck({ screenshots: many, otherFailures: 0 }, new Set()).kind).toBe('run');
  });
});

describe('baseRerunArgv', () => {
  it('re-runs the failing titles in their projects, escaped', () => {
    const argv = baseRerunArgv([
      { project: 'dark', title: 'a (1)', baseline: 'x' },
      { project: 'light', title: 'b', baseline: 'y' },
      { project: 'dark', title: 'c', baseline: 'z' },
    ]);
    expect(argv).toEqual([
      'npx', 'playwright', 'test',
      '--project=dark', '--project=light',
      '--grep', 'a \\(1\\)|b|c',
    ]);
  });
});

describe('classifyFailures', () => {
  const fails = [
    { project: 'dark', title: 'dash', baseline: 'a' },
    { project: 'dark', title: 'side', baseline: 'b' },
  ];
  it('puts a screenshot that fails at base in drift and one that passes there in breaks', () => {
    const baseRep = report({ title: 'dash', tests: [{ projectName: 'dark', status: 'unexpected', results: [] }] },
      { title: 'side', tests: [{ projectName: 'dark', status: 'expected', results: [] }] });
    expect(classifyFailures(fails, baseRep)).toEqual({ drift: [fails[0]], breaks: [fails[1]] });
  });
  it('treats a screenshot the base run never produced as the ticket\'s break', () => {
    expect(classifyFailures(fails, report())).toEqual({ drift: [], breaks: fails });
  });
});

describe('output', () => {
  const f = { project: 'dark', title: 'dash', baseline: 'a' };
  it('names both lists and the notice', () => {
    const lines = reportLines({ drift: [f], breaks: [] });
    expect(lines.join('\n')).toContain('develop drift, not this ticket');
    expect(lines.join('\n')).toContain('dark: dash');
    expect(lines.join('\n')).toContain(driftNotice(1));
  });
  it('lists the ticket breaks', () => {
    expect(reportLines({ drift: [], breaks: [f] }).join('\n')).toContain('ticket breaks');
  });
  it('words the notice', () => {
    expect(driftNotice(3)).toBe('develop has 3 drifted screenshots; see D311-style cleanup');
    expect(driftNotice(1)).toBe('develop has 1 drifted screenshot; see D311-style cleanup');
  });
});
