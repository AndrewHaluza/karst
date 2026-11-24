import { describe, expect, it } from 'vitest';
import {
  baselineProblems,
  changedBaselines,
  failingScreenshots,
  summaryMarkdown,
  gitArgs,
  isFullRun,
  layoutGateProblems,
  missingTests,
  neverRanCount,
  prChangedBaselines,
  prLedgerBase,
  repoRelative,
  screenshotStatuses,
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

  it('includes flaky specs only when asked', () => {
    const rep = report(failing('f'), { ...failing('g'), status: 'flaky' });
    expect(failingScreenshots(rep)).toHaveLength(1);
    expect(failingScreenshots(rep, ['unexpected', 'flaky'])).toHaveLength(2);
  });

  it('strips ANSI and falls back when no diff line exists', () => {
    const out = failingScreenshots(report(failing('x', 'dark', '\u001b[31mboom\u001b[39m')));
    expect(out[0].diff).toBe('diff size unavailable');
  });
});

describe('ledger keys of the report', () => {
  it('failingScreenshots names each failure by its ledger key', () => {
    const rep = report(failing('a', 'light'));
    rep.suites[0].specs[0].file = 'pages.visual.ts';
    expect(failingScreenshots(rep)[0].key).toBe('light|pages.visual.ts::a');
  });

  it('screenshotStatuses maps every screenshot test to its outcome, without the layout projects', () => {
    const rep = report(
      testEntry({ status: 'expected', title: 'ok' }),
      failing('bad', 'light'),
      { ...failing('wobbly'), status: 'flaky' },
      failing('geometry', 'layout'),
      testEntry({ project: 'layout-teardown', title: 'layout ledger verdict' }),
    );
    expect(screenshotStatuses(rep)).toEqual(
      new Map([
        ['dark|::ok', 'expected'],
        ['light|::bad', 'unexpected'],
        ['dark|::wobbly', 'flaky'],
      ]),
    );
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

describe('isFullRun', () => {
  it('is full only with a listing, no missing test and no test that never started', () => {
    expect(isFullRun({ listed: true, missing: 0, neverRan: 0 })).toBe(true);
  });

  it.each([
    ['no listing (a single local run)', { listed: false, missing: 0, neverRan: 0 }],
    ['a listed test that no shard reported', { listed: true, missing: 1, neverRan: 0 }],
    ['a test that never started', { listed: true, missing: 0, neverRan: 1 }],
  ])('is partial with %s', (_label, input) => {
    expect(isFullRun(input)).toBe(false);
  });
});

describe('prLedgerBase', () => {
  const PATH = 'tests/visual/visual-known-failures.json';

  it('asks git nothing outside a pull request', () => {
    let called = false;
    const base = prLedgerBase({
      env: { GITHUB_EVENT_NAME: 'push' },
      gitRun: () => {
        called = true;
        return { status: 0, stdout: '' };
      },
    });
    expect(called).toBe(false);
    expect(base).toBeNull();
  });

  it('reads the ledger of the base parent on a pull request', () => {
    const calls = [];
    const base = prLedgerBase({
      env: { GITHUB_EVENT_NAME: 'pull_request' },
      gitRun: (args) => {
        calls.push(args);
        return args[0] === 'ls-tree' ? { status: 0, stdout: `${PATH}\n` } : { status: 0, stdout: '["dark|::a"]' };
      },
    });
    expect(calls).toEqual([
      ['ls-tree', '--name-only', 'HEAD^1', '--', PATH],
      ['show', `HEAD^1:${PATH}`],
    ]);
    expect(base).toEqual(['dark|::a']);
  });

  it('is null when the base has no ledger yet', () => {
    const base = prLedgerBase({
      env: { GITHUB_EVENT_NAME: 'pull_request' },
      gitRun: () => ({ status: 0, stdout: '' }),
    });
    expect(base).toBeNull();
  });

  it('throws when git cannot read the base', () => {
    expect(() =>
      prLedgerBase({
        env: { GITHUB_EVENT_NAME: 'pull_request' },
        gitRun: () => ({ status: 128, stderr: 'unknown revision HEAD^1' }),
      }),
    ).toThrow(/HEAD\^1/);
  });
});

describe('summaryMarkdown', () => {
  const f = { key: 'dark|::a', id: '::a', project: 'dark', diff: '5 pixels (ratio 0.1 of all image pixels) are different' };
  const empty = { unexpected: [], known: [], stale: [], flaky: [], grown: [], owned: [], fullRun: true };

  it('names un-ledgered failures with the diff size and lists the ledgered ones', () => {
    const md = summaryMarkdown({ ...empty, unexpected: [f], known: [{ ...f, id: '::p' }] });
    expect(md).toContain('Failures the ledger does not list');
    expect(md).toContain('5 pixels');
    expect(md).toContain('Known failures');
  });

  it('lists stale entries, added entries, flaky screenshots and own baselines', () => {
    const md = summaryMarkdown({ ...empty, stale: ['dark|::s'], grown: ['dark|::g'], flaky: ['dark|::f'], owned: ['x'] });
    expect(md).toContain('Stale ledger entries');
    expect(md).toContain('dark|::s');
    expect(md).toContain('Ledger entries this PR adds');
    expect(md).toContain('dark|::g');
    expect(md).toContain('Flaky');
    expect(md).toContain('Own baselines failing');
  });

  it('says so when the run is partial and stale entries were not judged', () => {
    expect(summaryMarkdown({ ...empty, fullRun: false })).toContain('Partial run');
    expect(summaryMarkdown(empty)).not.toContain('Partial run');
  });
});

describe('neverRanCount', () => {
  it('counts skipped tests with no result, not intentional skips', () => {
    const never = { ...testEntry({ status: 'skipped', title: 'never' }), results: [] };
    const intentional = testEntry({ status: 'skipped', title: 'skip()' });
    expect(neverRanCount(report(never, intentional, testEntry({ status: 'expected' })))).toBe(1);
  });
});

/** A test entry as `merge-reports` writes it: attachment paths point into the merged blob's `resources/`. */
function mergedEntry({ project = 'dark', title = 'v/empty: full-page screenshot', snapshot, attachmentName = snapshot } = {}) {
  return {
    title,
    projectName: project,
    status: 'unexpected',
    results: [
      {
        error: {
          message: `\u001b[31mError: expect(page).toHaveScreenshot(expected) failed\u001b[39m\n\n  12 pixels (ratio 0.01 of all image pixels) are different.\n\n  Snapshot: ${snapshot}\n`,
        },
        attachments: [
          { name: `${attachmentName.replace(/\.png$/, '')}-expected.png`, contentType: 'image/png', path: '/w/all-blob/resources/0a1b.png' },
        ],
      },
    ],
  };
}

describe('baselineProblems on a merged report', () => {
  it('maps a failure to its baseline through the Snapshot line and the project', () => {
    const changed = new Set([`${BASELINES_DIR}/light/gettingStarted--empty.png`]);
    const problems = baselineProblems(report(mergedEntry({ project: 'light', snapshot: 'gettingStarted--empty.png' })), changed, '/repo');
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(`${BASELINES_DIR}/light/gettingStarted--empty.png`);
  });

  it('keeps the full name of a long snapshot that Playwright trims in the attachment name', () => {
    const name = 'settings--route-agents-agents-profiles-builtin-3AuatTester.png';
    const changed = new Set([`${BASELINES_DIR}/dark/${name}`]);
    const entry = mergedEntry({ snapshot: name, attachmentName: 'settings--route-agen-1a2b3-iltin-3AuatTester.png' });
    expect(baselineProblems(report(entry), changed, '/repo')).toHaveLength(1);
  });

  it('does not blame a baseline of another project', () => {
    const changed = new Set([`${BASELINES_DIR}/dark/a.png`]);
    expect(baselineProblems(report(mergedEntry({ project: 'hc', snapshot: 'a.png' })), changed, '/repo')).toEqual([]);
  });

  it('reports one problem for a failure that both the path and the Snapshot line name', () => {
    const changed = new Set([`${BASELINES_DIR}/dark/a.png`]);
    const entry = testEntry({ expected: { name: 'a', path: '/repo/tests/visual/__baselines__/dark' } });
    entry.results[0].error = { message: 'Snapshot: a.png' };
    expect(baselineProblems(report(entry), changed, '/repo')).toHaveLength(1);
  });
});

describe('missingTests', () => {
  const listed = report(
    testEntry({ project: 'dark', status: 'skipped', title: 'a' }),
    testEntry({ project: 'light', status: 'skipped', title: 'a' }),
    testEntry({ project: 'layout-teardown', status: 'skipped', title: 'layout ledger verdict' }),
  );

  it('is empty when the merged report holds every listed test', () => {
    const merged = report(
      testEntry({ project: 'layout-teardown', status: 'expected', title: 'layout ledger verdict' }),
      testEntry({ project: 'light', status: 'skipped', title: 'a' }),
      testEntry({ project: 'dark', status: 'expected', title: 'a' }),
    );
    expect(missingTests(listed, merged)).toEqual([]);
  });

  it('names each listed test that no shard reported', () => {
    const merged = report(testEntry({ project: 'dark', status: 'expected', title: 'a' }));
    expect(missingTests(listed, merged)).toEqual(['light ::a', 'layout-teardown ::layout ledger verdict']);
  });

  it('accepts a merged report that holds a test twice', () => {
    const merged = report(testEntry({ project: 'dark', title: 'a' }), testEntry({ project: 'dark', title: 'a' }));
    expect(missingTests(report(testEntry({ project: 'dark', title: 'a' })), merged)).toEqual([]);
  });
});
