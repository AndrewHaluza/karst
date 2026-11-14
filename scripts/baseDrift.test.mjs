import { describe, it, expect } from 'vitest';
import {
  BASE_RERUN_CAP,
  baseRerunArgv,
  classifyFailures,
  driftNotice,
  failingScreenshots,
  failedTests,
  collapseList,
  planBaseCheck,
  planHeadRerun,
  classifyHeadRerun,
  flakyNotice,
  headRerunLines,
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

const own = new Set(['b/own.png']);
const s1 = { project: 'hc', title: 'a', baseline: 'b/a.png' };
const s2 = { project: 'hc', title: 'o', baseline: 'b/own.png' };
const passing = (...shots) => report(...shots.map((s) => ({ title: s.title, tests: [{ projectName: s.project, status: 'expected', results: [] }] })));

describe('planHeadRerun', () => {
  it('runs the head re-run for screenshot failures', () => {
    expect(planHeadRerun({ screenshots: [s1], others: [] }, {})).toEqual({ kind: 'run' });
  });
  it('skips on GitHub Actions with the printed reason', () => {
    expect(planHeadRerun({ screenshots: [s1], others: [] }, { GITHUB_ACTIONS: 'true' })).toEqual({
      kind: 'skip',
      reason: 'flake re-run skipped: GitHub Actions never excuses a failure as a flake',
    });
  });
  it('skips above the cap as a real break', () => {
    const many = Array.from({ length: BASE_RERUN_CAP + 1 }, (_, i) => ({ ...s1, title: `t${i}` }));
    expect(planHeadRerun({ screenshots: many, others: [] }, {})).toEqual({
      kind: 'skip',
      reason: `flake re-run skipped: ${BASE_RERUN_CAP + 1} screenshots fail (cap ${BASE_RERUN_CAP}), a real break`,
    });
  });
  it('runs at the cap', () => {
    const many = Array.from({ length: BASE_RERUN_CAP }, (_, i) => ({ ...s1, title: `t${i}` }));
    expect(planHeadRerun({ screenshots: many, others: [] }, {}).kind).toBe('run');
  });
  it('never excuses a non-screenshot failure', () => {
    expect(planHeadRerun({ screenshots: [s1], others: [{ project: 'hc', title: 'x', message: '' }] }, {})).toEqual({ kind: 'skip' });
  });
  it('skips when nothing failed', () => {
    expect(planHeadRerun({ screenshots: [], others: [] }, {})).toEqual({ kind: 'skip' });
  });
});

describe('classifyHeadRerun', () => {
  it('calls a screenshot that passes on the re-run flaky', () => {
    expect(classifyHeadRerun([s1], passing(s1), own)).toEqual({ flaky: [s1], unstable: [], again: [] });
  });
  it('keeps a ticket-recorded baseline that passes on the re-run as unstable', () => {
    expect(classifyHeadRerun([s2], passing(s2), own)).toEqual({ flaky: [], unstable: [s2], again: [] });
  });
  it('sends a screenshot that fails again to the base check', () => {
    const again = report(shot('hc', 'a', '/r/b/a.png'));
    expect(classifyHeadRerun([s1], again, own)).toEqual({ flaky: [], unstable: [], again: [s1] });
  });
  it('treats a screenshot missing from the re-run report as failed again', () => {
    expect(classifyHeadRerun([s1], report(), own).again).toEqual([s1]);
  });
  it('matches by project and title', () => {
    expect(classifyHeadRerun([s1], passing({ ...s1, project: 'dark' }), own).again).toEqual([s1]);
  });
});

describe('head re-run lines', () => {
  it('prints the flaky notice in the vitest shape', () => {
    expect(flakyNotice([s1, { ...s1, project: 'dark' }])).toBe('NOTICE: flaky: hc: a; dark: a (passed when re-run)');
  });
  it('prints the unstable baseline label', () => {
    expect(headRerunLines({ flaky: [], unstable: [s2], again: [] })).toEqual([
      'unstable baseline: b/own.png (passed when re-run; CI rejects a baseline that does not match its own screenshot — make the layout settle, then re-record)',
    ]);
  });
  it('prints nothing when nothing passed', () => {
    expect(headRerunLines({ flaky: [], unstable: [], again: [s1] })).toEqual([]);
  });
});

describe('failedTests', () => {
  const BOOKENDS = ['clear layout shards', 'layout ledger verdict'];
  const spec = (project, title, status = 'unexpected', resultStatus = 'failed') => ({
    title,
    tests: [{ projectName: project, status, results: [{ status: resultStatus }] }],
  });
  const run = (specs, unexpected, over = {}) => ({ errors: [], stats: { unexpected }, suites: [{ specs }], ...over });

  it('names each failed test by project and title, and ignores the others', () => {
    const rep = run([spec('dark', 'a'), spec('light', 'a'), spec('dark', 'b', 'expected', 'passed'), spec('dark', 'c', 'flaky', 'passed'), spec('dark', 'd', 'skipped', 'skipped')], 2);
    expect(failedTests(rep, BOOKENDS)).toEqual([{ project: 'dark', title: 'a' }, { project: 'light', title: 'a' }]);
  });
  it('lists a project and title pair once', () => {
    const rep = { errors: [], stats: { unexpected: 2 }, suites: [{ specs: [spec('dark', 'a')] }, { specs: [spec('dark', 'a')] }] };
    expect(failedTests(rep, BOOKENDS)).toEqual([{ project: 'dark', title: 'a' }]);
  });
  it('keeps BASE_RERUN_CAP failures', () => {
    const specs = Array.from({ length: BASE_RERUN_CAP }, (_, i) => spec('dark', `t${i}`));
    expect(failedTests(run(specs, BASE_RERUN_CAP), BOOKENDS)).toHaveLength(BASE_RERUN_CAP);
  });
  it.each([
    ['no report', null],
    ['a global error', run([spec('dark', 'a')], 1, { errors: [{ message: 'webServer' }] })],
    ['no stats', { errors: [], suites: [{ specs: [spec('dark', 'a')] }] }],
    ['a count that differs from stats.unexpected', run([spec('dark', 'a')], 2)],
    ['no failure', run([spec('dark', 'a', 'expected', 'passed')], 0)],
    ['an interrupted test', run([spec('dark', 'a'), spec('dark', 'b', 'skipped', 'interrupted')], 1)],
    ['a failed ledger verdict', run([spec('layout-teardown', 'layout ledger verdict')], 1)],
    ['a failed shard setup', run([spec('layout-setup', 'clear layout shards')], 1)],
    ['a failure with no project', run([{ title: 'a', tests: [{ status: 'unexpected', results: [] }] }], 1)],
    ['a failure with no title', run([spec('dark', '')], 1)],
    ['more than BASE_RERUN_CAP failures', run(Array.from({ length: BASE_RERUN_CAP + 1 }, (_, i) => spec('dark', `t${i}`)), BASE_RERUN_CAP + 1)],
  ])('is null for %s', (_, rep) => expect(failedTests(rep, BOOKENDS)).toBeNull());
});
