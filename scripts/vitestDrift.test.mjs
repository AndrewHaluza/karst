import { describe, it, expect } from 'vitest';
import {
  BASE_FILE_CAP,
  alertLine,
  allFailuresParsed,
  cacheKey,
  classifyFailures,
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
