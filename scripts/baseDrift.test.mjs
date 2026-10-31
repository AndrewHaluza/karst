import { describe, it, expect } from 'vitest';
import {
  BASE_RERUN_CAP,
  baseRerunArgv,
  classifyFailures,
  driftNotice,
  failingScreenshots,
  collapseList,
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
      others: [],
    });
  });

  it('counts a failure without an expected image as another failure', () => {
    const rep = report({ title: 'boom', tests: [{ projectName: 'dark', status: 'unexpected', results: [] }] });
    expect(failingScreenshots(rep, '/repo')).toEqual({
      screenshots: [],
      others: [{ project: 'dark', title: 'boom', message: '' }],
    });
  });

  it('walks nested suites', () => {
    const rep = { suites: [{ suites: [{ specs: [shot('light', 'a', '/repo/b.png')] }] }] };
    expect(failingScreenshots(rep, '/repo').screenshots).toHaveLength(1);
  });
});

describe('planBaseCheck', () => {
  const s = (n) => ({ project: 'dark', title: `t${n}`, baseline: `b${n}.png` });
  it('skips when there are no failures to check', () => {
    expect(planBaseCheck({ screenshots: [], others: [] }, new Set())).toEqual({ kind: 'skip' });
  });
  it('fails as today when a non-screenshot failure exists', () => {
    expect(planBaseCheck({ screenshots: [s(1)], others: [{ project: 'dark', title: 'x', message: 'm' }] }, new Set())).toMatchObject({ kind: 'fail' });
  });
  it('fails as today when a failing baseline is one the ticket recorded', () => {
    const plan = planBaseCheck({ screenshots: [s(1), s(2)], others: [] }, new Set(['b2.png']));
    expect(plan).toMatchObject({ kind: 'fail' });
    expect(plan.reason).toContain('b2.png');
  });
  it('fails with the wholesale reason above the cap', () => {
    const many = Array.from({ length: BASE_RERUN_CAP + 1 }, (_, i) => s(i));
    const plan = planBaseCheck({ screenshots: many, others: [] }, new Set());
    expect(plan.kind).toBe('fail');
    expect(plan.reason).toContain('base likely drifted wholesale');
  });
  it('runs at exactly the cap', () => {
    const many = Array.from({ length: BASE_RERUN_CAP }, (_, i) => s(i));
    expect(planBaseCheck({ screenshots: many, others: [] }, new Set()).kind).toBe('run');
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

const ledgerFail = {
  title: 'layout.teardown',
  tests: [
    {
      projectName: 'layout',
      status: 'unexpected',
      results: [{ error: { message: `\u001b[31mlayout ledger verdict\u001b[0m\n171 STALE\n128 NEW\n${'x'.repeat(900)}` } }],
    },
  ],
};

describe('non-screenshot failures are named', () => {
  it('keeps project, title and the ledger verdict', () => {
    const { others } = failingScreenshots(report(ledgerFail), '/repo');
    expect(others).toEqual([{ project: 'layout', title: 'layout.teardown', message: 'ledger: 171 STALE, 128 NEW' }]);
  });
  it('cuts a plain message to 300 chars', () => {
    const rep = report({ title: 't', tests: [{ projectName: 'p', status: 'unexpected', results: [{ error: { message: 'y'.repeat(900) } }] }] });
    expect(failingScreenshots(rep, '/repo').others[0].message).toHaveLength(300);
  });
  it('names them in the fail reason, at most 5 then +N more', () => {
    const o = (n) => ({ project: 'layout', title: `t${n}`, message: 'boom' });
    const one = planBaseCheck({ screenshots: [], others: [{ project: 'layout', title: 'layout.teardown', message: 'ledger: 171 STALE, 128 NEW' }] }, new Set());
    expect(one.reason).toBe('1 failure is not a screenshot mismatch: [layout] layout.teardown — ledger: 171 STALE, 128 NEW');
    const many = planBaseCheck({ screenshots: [], others: Array.from({ length: 7 }, (_, i) => o(i)) }, new Set());
    expect(many.reason).toContain('7 failures are not screenshot mismatches');
    expect(many.reason).toContain('[layout] t4 — boom');
    expect(many.reason).not.toContain('t5');
    expect(many.reason).toContain('+2 more');
  });
});

describe('collapseList', () => {
  it('lists up to 10 then and N more (M total)', () => {
    const items = Array.from({ length: 25 }, (_, i) => `n${i}`);
    expect(collapseList(items)).toEqual([...items.slice(0, 10), 'and 15 more (25 total)']);
    expect(collapseList(items.slice(0, 10))).toEqual(items.slice(0, 10));
  });
  it('collapses screenshot lists in the report', () => {
    const f = Array.from({ length: 30 }, (_, i) => ({ project: 'dark', title: `s${i}`, baseline: `b${i}` }));
    const text = reportLines({ drift: f, breaks: [] }).join('\n');
    expect(text).toContain('and 20 more (30 total)');
    expect(text).not.toContain('s29');
  });
});
