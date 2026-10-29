import { describe, expect, it } from 'vitest';
import {
  baselineProblems,
  changedBaselines,
  classifyFailures,
  failingScreenshots,
  summaryMarkdown,
  gitArgs,
  layoutGateProblems,
  prChangedBaselines,
  repoRelative,
  BASELINES_DIR,
} from './visual-sweep-gate.mjs';

/** One Playwright JSON `test` entry, shaped like the json reporter's output. */
function testEntry({ project = 'dark', status = 'unexpected', title = 'view/empty: full-page screenshot', expected } = {}) {
  return {
    title,
    projectName: project,
    status,
    results: [
      {
        attachments: expected
          ? [
              { name: `${expected.name}-expected.png`, contentType: 'image/png', path: `${expected.path}/${expected.name}.png` },
              { name: `${expected.name}-actual.png`, contentType: 'image/png', path: '/repo/test-results/actual.png' },
            ]
          : [{ name: 'error-context', contentType: 'text/markdown', path: '/repo/test-results/error-context.md' }],
      },
    ],
  };
}

function report(...tests) {
  return {
    stats: { expected: 0, unexpected: tests.length, flaky: 0, skipped: 0 },
    suites: [
      {
        specs: tests.map((t) => ({ title: t.title, tests: [t] })),
      },
    ],
  };
}

describe('changedBaselines', () => {
  it('keeps the baselines and drops every other path', () => {
    const changed = changedBaselines(
      [
        'src/ui/gettingStarted/webview.html',
        `${BASELINES_DIR}/dark/gettingStarted--empty.png`,
        `${BASELINES_DIR}/dark/resources--waste.png`,
        'tests/visual/variants.ts',
        '',
      ].join('\n'),
    );
    expect([...changed].sort()).toEqual([
      `${BASELINES_DIR}/dark/gettingStarted--empty.png`,
      `${BASELINES_DIR}/dark/resources--waste.png`,
    ]);
  });

  it('is empty for an empty diff', () => {
    expect(changedBaselines('')).toEqual(new Set());
  });
});

describe('repoRelative', () => {
  it('turns an absolute report path into the path git prints', () => {
    expect(repoRelative('/work/tests/visual/__baselines__/dark/a.png', '/work')).toBe(
      `${BASELINES_DIR}/dark/a.png`,
    );
  });

  it('keeps an already-relative path as it is', () => {
    expect(repoRelative(`${BASELINES_DIR}/dark/a.png`, '/work')).toBe(`${BASELINES_DIR}/dark/a.png`);
  });
});

describe('gitArgs', () => {
  it('marks only this repository safe, then runs the command', () => {
    expect(gitArgs('/work/repo', ['diff', '--name-only'])).toEqual([
      '-c',
      'safe.directory=/work/repo',
      'diff',
      '--name-only',
    ]);
  });
});

describe('prChangedBaselines', () => {
  it('asks git nothing outside a pull request', () => {
    let called = false;
    const changed = prChangedBaselines({
      env: { GITHUB_EVENT_NAME: 'push' },
      gitRun: () => {
        called = true;
        return { status: 0, stdout: '' };
      },
    });
    expect(called).toBe(false);
    expect(changed).toEqual(new Set());
  });

  it('diffs the merge commit against its base parent on a pull request', () => {
    let argv;
    const changed = prChangedBaselines({
      env: { GITHUB_EVENT_NAME: 'pull_request' },
      gitRun: (args) => {
        argv = args;
        return { status: 0, stdout: `${BASELINES_DIR}/dark/a.png\nsrc/ui/x.ts\n` };
      },
    });
    expect(argv).toEqual([
      'diff',
      '--name-only',
      '--diff-filter=ACMR',
      'HEAD^1',
      'HEAD',
      '--',
      BASELINES_DIR,
    ]);
    expect(changed).toEqual(new Set([`${BASELINES_DIR}/dark/a.png`]));
  });

  it('throws when git cannot diff, instead of silently going advisory', () => {
    expect(() =>
      prChangedBaselines({
        env: { GITHUB_EVENT_NAME: 'pull_request' },
        gitRun: () => ({ status: 128, stderr: 'unknown revision HEAD^1' }),
      }),
    ).toThrow(/fetch-depth 2/);
  });
});

describe('baselineProblems', () => {
  it('fails a PR-owned baseline that does not match its own screenshot', () => {
    const changed = new Set([`${BASELINES_DIR}/dark/gettingStarted--empty.png`]);
    const problems = baselineProblems(
      report(
        testEntry({
          title: 'gettingStarted/empty: full-page screenshot',
          expected: { name: 'gettingStarted--empty', path: '/repo/tests/visual/__baselines__/dark' },
        }),
      ),
      changed,
      '/repo',
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('gettingStarted--empty');
    expect(problems[0]).toContain('added or changed');
  });

  it('leaves a pre-existing failure advisory', () => {
    const changed = new Set([`${BASELINES_DIR}/dark/resources--empty.png`]);
    const problems = baselineProblems(
      report(
        testEntry({
          title: 'gettingStarted/empty: full-page screenshot',
          expected: { name: 'gettingStarted--empty', path: '/repo/tests/visual/__baselines__/dark' },
        }),
      ),
      changed,
      '/repo',
    );
    expect(problems).toEqual([]);
  });

  it('ignores a changed baseline whose test passed', () => {
    const changed = new Set([`${BASELINES_DIR}/dark/a.png`]);
    const problems = baselineProblems(
      report(
        testEntry({
          status: 'expected',
          expected: { name: 'a', path: '/repo/tests/visual/__baselines__/dark' },
        }),
      ),
      changed,
      '/repo',
    );
    expect(problems).toEqual([]);
  });

  it('ignores a failure with no expected image (missing baseline)', () => {
    expect(baselineProblems(report(testEntry({ title: 'a/b: full-page screenshot' })), new Set(), '/repo')).toEqual([]);
  });
});

describe('layoutGateProblems', () => {
  it('fails when the layout project ran no tests', () => {
    expect(layoutGateProblems(report(testEntry({ project: 'layout-teardown', status: 'expected' })))).toEqual([
      'project `layout` ran zero tests',
    ]);
  });

  it('fails when a layout test is unexpected', () => {
    const problems = layoutGateProblems(
      report(
        testEntry({ project: 'layout', status: 'unexpected', title: 'geometry' }),
        testEntry({ project: 'layout-teardown', status: 'expected', title: 'verdict' }),
      ),
    );
    expect(problems).toContain('layout: "geometry" failed (see the grouped layout output above)');
  });
});

/** A failing screenshot carrying Playwright's pixel-diff message. */
function failing(title, project = 'dark', message = 'Screenshot comparison failed:\n\n  1200 pixels (ratio 0.02 of all image pixels) are different.') {
  const t = testEntry({ title, project });
  t.results[0].error = { message };
  return t;
}

describe('failingScreenshots', () => {
  it('lists failures with project and diff size, skipping passes and layout projects', () => {
    const rep = report(
      failing('dash: full-page screenshot'),
      testEntry({ status: 'expected', title: 'ok' }),
      failing('geometry', 'layout'),
      failing('size', 'light', 'Expected an image 100px by 200px, received 100px by 250px.'),
    );
    const out = failingScreenshots(rep);
    expect(out.map((f) => [f.project, f.diff])).toEqual([
      ['dark', '1200 pixels (ratio 0.02 of all image pixels) are different'],
      ['light', 'Expected an image 100px by 200px, received 100px by 250px.'],
    ]);
    expect(out[0].id).toContain('dash: full-page screenshot');
  });

  it('strips ANSI and falls back when no diff line exists', () => {
    const out = failingScreenshots(report(failing('x', 'dark', '\u001b[31mboom\u001b[39m')));
    expect(out[0].diff).toBe('diff size unavailable');
  });
});

describe('classifyFailures', () => {
  const a = { id: '::a', project: 'dark', diff: 'd' };
  const b = { id: '::b', project: 'dark', diff: 'd' };

  it('new break: red here, not red on develop', () => {
    const r = classifyFailures([a, b], [{ id: '::a', project: 'dark' }]);
    expect(r.newBreaks).toEqual([b]);
    expect(r.preExisting).toEqual([a]);
    expect(r.developKnown).toBe(true);
  });

  it('same id in another project is a new break', () => {
    const r = classifyFailures([{ ...a, project: 'light' }], [{ id: '::a', project: 'dark' }]);
    expect(r.newBreaks).toHaveLength(1);
  });

  it('no develop artifact: nothing blocks', () => {
    const r = classifyFailures([a], null);
    expect(r).toEqual({ newBreaks: [], preExisting: [], developKnown: false });
  });

  it('own-baseline failures stay a separate rule', () => {
    const changed = new Set([`${BASELINES_DIR}/dark/own.png`]);
    const rep = report(testEntry({ title: 'own', expected: { name: 'own', path: '/repo/tests/visual/__baselines__/dark' } }));
    expect(baselineProblems(rep, changed, '/repo')).toHaveLength(1);
  });

  it('zero-run is still caught by layout gate (no layout tests)', () => {
    expect(layoutGateProblems({ suites: [] })).toContain('project `layout` ran zero tests');
  });
});

describe('summaryMarkdown', () => {
  const f = { id: '::a', project: 'dark', diff: '5 pixels (ratio 0.1 of all image pixels) are different' };
  it('names new breaks with diff size and lists pre-existing', () => {
    const md = summaryMarkdown({ newBreaks: [f], preExisting: [{ ...f, id: '::p' }], developKnown: true, owned: [] });
    expect(md).toContain('New breaks');
    expect(md).toContain('5 pixels');
    expect(md).toContain('Pre-existing on develop');
  });
  it('says so when develop red set is missing', () => {
    const md = summaryMarkdown({ newBreaks: [], preExisting: [], developKnown: false, owned: ['x'] });
    expect(md).toContain('No develop red set available');
    expect(md).toContain('Own baselines failing');
  });
});
