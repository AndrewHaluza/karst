import { describe, it, expect } from 'vitest';
import {
  slowestTests,
  slowestLines,
  BASE_FILE_CAP,
  FLAKE_FILE_CAP,
  alertLine,
  allFailuresParsed,
  cacheKey,
  classifyFailures,
  classifyFileRerun,
  classifyRerun,
  failingFilesFromOutput,
  flakeNotice,
  hasUnhandledError,
  isCleanRerun,
  planFlakeRerun,
  planUnparseableFlakeRerun,
  driftNotice,
  failingTestIds,
  fileOfId,
  planBaseCheck,
  ranTests,
  reportLines,
} from './vitestDrift.mjs';

const ID_A = 'src/a.test.ts > suite > a runs nothing';
const ID_B = 'src/b.test.ts > b works';

describe('failingTestIds', () => {
  it('reads FAIL lines, strips ANSI and dedupes', () => {
    const out = `\u001b[31m FAIL \u001b[0m x\nFAIL  ${ID_A} 3ms\nFAIL  ${ID_A}\n× ${ID_B}\nFAIL  src/c.test.ts\n`;
    expect(failingTestIds(out)).toEqual([ID_A, ID_B]);
  });
  it('is empty for non-vitest output', () => {
    expect(failingTestIds('boom')).toEqual([]);
  });
});

describe('fileOfId', () => {
  it('takes the file, dropping a project prefix', () => {
    expect(fileOfId(ID_A)).toBe('src/a.test.ts');
    expect(fileOfId('|unit| src/a.test.ts > t')).toBe('src/a.test.ts');
  });
});

describe('planBaseCheck', () => {
  it('skips when no ids parse', () => {
    expect(planBaseCheck([], new Set()).kind).toBe('skip');
  });
  it('never drifts a test file the ticket changed', () => {
    const plan = planBaseCheck([ID_A, ID_B], new Set(['src/b.test.ts']));
    expect(plan.kind).toBe('fail');
    expect(plan.reason).toContain('src/b.test.ts');
  });
  it('fails above the file cap and names it', () => {
    const ids = Array.from({ length: BASE_FILE_CAP + 1 }, (_, i) => `src/f${i}.test.ts > t`);
    const plan = planBaseCheck(ids, new Set());
    expect(plan.kind).toBe('fail');
    expect(plan.reason).toContain(`cap ${BASE_FILE_CAP}`);
  });
  it('runs the distinct files otherwise', () => {
    expect(planBaseCheck([ID_A, `${ID_A}2`, ID_B], new Set())).toEqual({ kind: 'run', files: ['src/a.test.ts', 'src/b.test.ts'] });
  });
});

describe('classifyFailures', () => {
  it('red at base is drift, green at base is the ticket break', () => {
    expect(classifyFailures([ID_A, ID_B], new Set([ID_A]))).toEqual({ drift: [ID_A], breaks: [ID_B] });
  });
  it('all drift leaves no breaks', () => {
    expect(classifyFailures([ID_A], new Set([ID_A])).breaks).toEqual([]);
  });
});

describe('cacheKey', () => {
  it('is stable and varies per repo, sha and id', () => {
    const k = cacheKey('r', 's', ID_A);
    expect(cacheKey('r', 's', ID_A)).toBe(k);
    expect(new Set([k, cacheKey('r2', 's', ID_A), cacheKey('r', 's2', ID_A), cacheKey('r', 's', ID_B)]).size).toBe(4);
  });
});

describe('report', () => {
  it('prints the NOTICE and the alert line', () => {
    expect(reportLines({ drift: [ID_A], breaks: [] }).join('\n')).toContain(`NOTICE: develop is red: ${ID_A}`);
    expect(driftNotice([ID_A, ID_B])).toBe(`NOTICE: develop is red: ${ID_A}; ${ID_B}`);
    expect(alertLine('abc', [ID_A])).toBe(`KARST-ALERT: develop-red base=abc tests=${ID_A}`);
  });
  it('lists the ticket breaks', () => {
    expect(reportLines({ drift: [], breaks: [ID_B] }).join('\n')).toContain('ticket breaks');
  });
});

describe('ranTests', () => {
  it('is true when vitest printed its summary, even for a failing run', () => {
    expect(ranTests('\u001b[2m Test Files \u001b[22m \u001b[31m1 failed\u001b[39m (1)\n')).toBe(true);
    expect(ranTests(' Test Files  2 passed (2)\n')).toBe(true);
  });
  it('is false when vitest never ran the files (startup error, no test files found)', () => {
    expect(ranTests('No test files found, exiting with code 1\nStartup Error\n')).toBe(false);
    expect(ranTests('')).toBe(false);
  });
});

describe('allFailuresParsed', () => {
  const sum = (files, tests, extra = '') => ` Test Files  ${files}\n      Tests  ${tests}\n${extra}`;
  it('accepts when every counted failure has an id', () => {
    expect(allFailuresParsed(sum('1 failed | 2 passed (3)', '1 failed | 5 passed (6)'), [ID_A])).toBe(true);
  });
  it('rejects more failed tests than parsed ids', () => {
    expect(allFailuresParsed(sum('1 failed (1)', '2 failed (2)'), [ID_A])).toBe(false);
  });
  it('rejects a failed file with no failed test (suite error)', () => {
    expect(allFailuresParsed(sum('2 failed (2)', '1 failed (1)'), [ID_A])).toBe(false);
  });
  it('rejects unhandled errors and missing summaries', () => {
    expect(allFailuresParsed(sum('1 failed (1)', '1 failed (1)', '     Errors  1 error\n'), [ID_A])).toBe(false);
    expect(allFailuresParsed('boom', [ID_A])).toBe(false);
  });
});

describe('planBaseCheck dependency changes', () => {
  it('never drifts when the ticket changed dependency files', () => {
    expect(planBaseCheck([ID_A], new Set(['package.json'])).kind).toBe('fail');
    expect(planBaseCheck([ID_A], new Set(['sub/package-lock.json'])).kind).toBe('fail');
  });
});

describe('flake re-run', () => {
  const pass = { status: 0, failed: new Set() };
  it('passes alone: flaky, with the NOTICE', () => {
    expect(classifyRerun([ID_A], new Map([['src/a.test.ts', pass]]))).toEqual({ flaky: [ID_A], breaks: [] });
    expect(flakeNotice([ID_A, ID_B])).toBe(`NOTICE: flaky: ${ID_A}; ${ID_B} (passed when re-run alone)`);
  });
  it('fails twice: a break', () => {
    const again = { status: 1, failed: new Set([ID_A]) };
    expect(classifyRerun([ID_A], new Map([['src/a.test.ts', again]]))).toEqual({ flaky: [], breaks: [ID_A] });
  });
  it('a file that fails alone with no parseable id breaks all its ids', () => {
    expect(classifyRerun([ID_A], new Map([['src/a.test.ts', { status: 1, failed: new Set() }]])).breaks).toEqual([ID_A]);
  });
  it('re-runs up to the cap, skips above it with the file count', () => {
    expect(planFlakeRerun([ID_A, ID_B])).toEqual({ kind: 'run', files: ['src/a.test.ts', 'src/b.test.ts'] });
    const ids = Array.from({ length: FLAKE_FILE_CAP + 1 }, (_, i) => `src/f${i}.test.ts > t`);
    const plan = planFlakeRerun(ids);
    expect(plan.kind).toBe('skip');
    expect(plan.reason).toContain(`flake re-run skipped: ${FLAKE_FILE_CAP + 1} files`);
  });
});

describe('hasUnhandledError', () => {
  it('sees an unhandled rejection or error section, ANSI or not', () => {
    expect(hasUnhandledError('⎯⎯ Unhandled Rejection ⎯⎯\nError: leaked\n')).toBe(true);
    expect(hasUnhandledError('⎯⎯ Unhandled Error ⎯⎯\nboom\n')).toBe(true);
    expect(hasUnhandledError('     Errors  1 error\n')).toBe(true);
    expect(hasUnhandledError('\u001b[31m     Errors  1 error\u001b[39m\n')).toBe(true);
  });
  it('is false for a clean summary and for a plain assertion failure', () => {
    expect(hasUnhandledError(' Test Files  1 failed (1)\n      Tests  1 failed (1)\n')).toBe(false);
    expect(hasUnhandledError('')).toBe(false);
  });
});

describe('failingFilesFromOutput', () => {
  it('reads the test file of FAIL and × test ids, with and without a project prefix', () => {
    const out = [
      ' FAIL  src/a.test.ts > suite > a 3ms',
      ' FAIL  |unit| src/b.test.ts > b',
      ' × src/c.test.ts > c 6ms',
      ' × |integration| src/d.test.ts > d',
    ].join('\n');
    expect(failingFilesFromOutput(out)).toEqual(['src/a.test.ts', 'src/b.test.ts', 'src/c.test.ts', 'src/d.test.ts']);
  });
  it('reads file-level failures and ignores labels that name no test file', () => {
    const out = [
      ' FAIL  src/c.test.ts',
      ' FAIL  src/d.test.ts [ src/d.test.ts ]',
      ' FAIL  |unit| src/e.test.ts',
      ' × src/f.test.ts (1 test | 1 failed)',
      ' FAIL  x',
      ' × flips',
    ].join('\n');
    expect(failingFilesFromOutput(out)).toEqual(['src/c.test.ts', 'src/d.test.ts', 'src/e.test.ts', 'src/f.test.ts']);
  });
  it('reads test files from unhandled-error stack frames, never sources or dependencies', () => {
    const out = [
      '⎯⎯⎯⎯⎯ Unhandled Rejection ⎯⎯⎯⎯⎯',
      'Error: leaked',
      ' ❯ src/d.test.ts:12:5',
      ' at fn (/repo/src/e.test.ts:10:2)',
      ' at file:///repo/scripts/f.test.mjs:4:1',
      ' ❯ src/d.ts:12:5',
      ' ❯ node_modules/x/src/g.test.ts:1:1',
      ' ❯ node:internal/process/task:1:1',
      '⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯',
      ' Test Files  1 failed (1)',
    ].join('\n');
    expect(failingFilesFromOutput(out, '/repo')).toEqual(['src/d.test.ts', 'src/e.test.ts', 'scripts/f.test.mjs']);
  });
  it('keeps only the path of a named Vitest ❯ frame, never the function name', () => {
    const out = [
      '⎯⎯⎯⎯ Unhandled Rejection ⎯⎯⎯⎯⎯',
      'Error: leaked',
      ' ❯ leak scripts/a.test.mjs:3:18',
      ' ❯ runWithTimeout ../../../node_modules/@vitest/runner/dist/chunk-artifact.js:2272:10',
      ' Test Files  1 failed (1)',
    ].join('\n');
    expect(failingFilesFromOutput(out)).toEqual(['scripts/a.test.mjs']);
  });
  it('dedupes in first-seen order', () => {
    const out = [
      ' FAIL  src/a.test.ts > suite > a',
      '⎯⎯ Unhandled Rejection ⎯⎯',
      ' ❯ ./src/b.test.ts:3:4',
      ' ❯ src/a.test.ts:9:9',
    ].join('\n');
    expect(failingFilesFromOutput(out)).toEqual(['src/a.test.ts', 'src/b.test.ts']);
  });
});

describe('planUnparseableFlakeRerun', () => {
  const FAIL_UNHANDLED = [
    ' FAIL  src/workflow/gates/runList.test.ts > lists > flips 5ms',
    ' Test Files  1 failed (3)',
    '      Tests  1 failed | 5 passed (6)',
    '⎯⎯ Unhandled Rejection ⎯⎯',
    'Error: leaked',
    ' ❯ src/workflow/gates/runList.test.ts:12:5',
  ].join('\n');
  it('still plans the alone re-run for the FAIL line beside an unhandled rejection', () => {
    expect(planUnparseableFlakeRerun(FAIL_UNHANDLED)).toEqual({ kind: 'run', files: ['src/workflow/gates/runList.test.ts'] });
  });
  it('plans nothing when the output names no failing test file', () => {
    const out = [' Test Files  1 failed (1)', '      Tests  1 failed (1)', '     Errors  1 error'].join('\n');
    const plan = planUnparseableFlakeRerun(out);
    expect(plan.kind).toBe('skip');
    expect(plan.reason).toBe('flake re-run skipped: no failing test files');
  });
  it('never re-runs on GitHub Actions', () => {
    const plan = planUnparseableFlakeRerun(FAIL_UNHANDLED, { env: { GITHUB_ACTIONS: 'true' } });
    expect(plan.kind).toBe('skip');
    expect(plan.reason).toBe('flake re-run skipped: GitHub Actions never excuses a failure');
  });
  it('reads the file of an unhandled-error stack when there is no FAIL line', () => {
    const out = ['     Errors  1 error', '⎯⎯ Unhandled Error ⎯⎯', ' ❯ src/d.test.ts:12:5', ' Test Files  1 failed (1)'].join('\n');
    expect(planUnparseableFlakeRerun(out, { cwd: null })).toEqual({ kind: 'run', files: ['src/d.test.ts'] });
  });
  it('plans nothing above the file cap', () => {
    const out = [...Array.from({ length: FLAKE_FILE_CAP + 1 }, (_, i) => ` FAIL  src/f${i}.test.ts`), ` Test Files  ${FLAKE_FILE_CAP + 1} failed (${FLAKE_FILE_CAP + 1})`].join('\n');
    const plan = planUnparseableFlakeRerun(out);
    expect(plan.kind).toBe('skip');
    expect(plan.reason).toContain(`flake re-run skipped: ${FLAKE_FILE_CAP + 1} files`);
  });
  it('plans nothing when fewer files than the reported failed files could be read', () => {
    const out = [' FAIL  src/a.test.ts', ' Test Files  2 failed (2)'].join('\n');
    const plan = planUnparseableFlakeRerun(out);
    expect(plan.kind).toBe('skip');
    expect(plan.reason).toBe('flake re-run skipped: only 1 of 2 failed test files could be read');
  });
  it('plans nothing when the run printed no Test Files summary, so its failing set is unknown', () => {
    const out = [' FAIL  src/a.test.ts > suite > a', '⎯⎯ Unhandled Rejection ⎯⎯', 'Error: leaked'].join('\n');
    const plan = planUnparseableFlakeRerun(out);
    expect(plan.kind).toBe('skip');
    expect(plan.reason).toBe('flake re-run skipped: no Test Files summary, so the run did not finish');
  });
});

describe('isCleanRerun and classifyFileRerun', () => {
  const CLEAN = [' Test Files  1 passed (1)', '      Tests  2 passed (2)'].join('\n');
  const cleanRun = { status: 0, out: CLEAN };
  it('a clean alone run is flaky, no breaks', () => {
    expect(isCleanRerun(cleanRun)).toBe(true);
    expect(classifyFileRerun(['src/a.test.ts'], new Map([['src/a.test.ts', cleanRun]]))).toEqual({ flaky: ['src/a.test.ts'], breaks: [] });
  });
  it('an unhandled error or an error line is a break even at status 0', () => {
    const sum = (extra) => [' Test Files  1 passed (1)', '      Tests  1 passed (1)', extra].join('\n');
    expect(isCleanRerun({ status: 0, out: sum('⎯⎯ Unhandled Rejection ⎯⎯') })).toBe(false);
    expect(isCleanRerun({ status: 0, out: sum('     Errors  1 error') })).toBe(false);
    expect(classifyFileRerun(['src/a.test.ts'], new Map([['src/a.test.ts', { status: 0, out: sum('     Errors  1 error') }]])).breaks).toEqual(['src/a.test.ts']);
  });
  it('a nonzero status, no summary, a hang or a signal is a break', () => {
    expect(isCleanRerun({ status: 1, out: CLEAN })).toBe(false);
    expect(isCleanRerun({ status: 0, out: 'boom' })).toBe(false);
    expect(isCleanRerun({ ...cleanRun, hung: true })).toBe(false);
    expect(isCleanRerun({ ...cleanRun, signaled: true })).toBe(false);
  });
  it('splits a mixed re-run into flaky and breaks', () => {
    const alone = new Map([
      ['src/a.test.ts', cleanRun],
      ['src/b.test.ts', { status: 1, out: ' FAIL  src/b.test.ts > b' }],
    ]);
    expect(classifyFileRerun(['src/a.test.ts', 'src/b.test.ts'], alone)).toEqual({ flaky: ['src/a.test.ts'], breaks: ['src/b.test.ts'] });
  });
  it('a file with no re-run result is a break', () => {
    expect(classifyFileRerun(['src/a.test.ts'], new Map())).toEqual({ flaky: [], breaks: ['src/a.test.ts'] });
  });
});

describe('classifyRerun unhandled errors', () => {
  it('an unhandled error on the alone run breaks the id even at status 0', () => {
    const r = { status: 0, failed: new Set(), unhandled: true };
    expect(classifyRerun([ID_A], new Map([['src/a.test.ts', r]])).breaks).toEqual([ID_A]);
  });
});

describe('slowestTests', () => {
  const out = [
    ' \u001b[32m✓\u001b[39m src/a.test.ts \u001b[2m(2 tests)\u001b[22m\u001b[33m 943\u001b[2mms\u001b[22m',
    '     ✓ slow case 20413ms',
    '     ✓ fast case 5ms',
    ' ✓ src/b.test.ts (1 test) 100ms',
    ' ✓ src/b.test.ts (1 test) 100ms',
  ].join('\n');
  it('lists the slowest first, deduped, capped', () => {
    expect(slowestTests(out, 2)).toEqual(['slow case — 20413ms', 'src/a.test.ts (2 tests) — 943ms']);
    expect(slowestTests(out).filter((r) => r.startsWith('src/b'))).toHaveLength(1);
  });
  it('prints nothing without timed lines', () => {
    expect(slowestLines('no timings')).toEqual([]);
    expect(slowestLines(out, 1)).toEqual(['Slowest tests:', '  slow case — 20413ms']);
  });
});
