import { describe, expect, it } from 'vitest';
import {
  baselineProblems,
  changedBaselines,
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
