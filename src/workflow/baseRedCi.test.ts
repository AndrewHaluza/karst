import { describe, expect, it } from 'vitest';
import { BASE_RED_PREFIX, BASE_RED_WAIT_PREFIX, extractFailingTestIds, isBaseRed, isBaseRedPattern } from './baseRedCi.js';

// Verbatim lines of develop run 45810045962 (gh prefix and timestamps kept).
const P = 'Visual regression (blocks new breaks)\tMerge the shard reports and run the gate\t';
const CROSS = `${P}2026-11-26T11:30:17.2720361Z   ✘   968 [dark] › tests/visual/pages.visual.ts:71:7 › full-page screenshots › dashboard/stage-menu-bottom-edge: full-page screenshot @NOT-LIGHT @NOT-HC @NOT-DARK-GRAYSCALE @NOT-DARK-REDUCED-MOTION @NOT-CATALOG (1.1s)`;
const LIST = `${P}2026-11-26T11:30:17.5736450Z   1) [dark] › tests/visual/pages.visual.ts:71:7 › full-page screenshots › dashboard/stage-menu-bottom-edge: full-page screenshot @NOT-LIGHT @NOT-HC @NOT-DARK-GRAYSCALE @NOT-DARK-REDUCED-MOTION @NOT-CATALOG `;
const GATE = `${P}2026-11-26T11:30:18.1275736Z - dark pages.visual.ts::dashboard/stage-menu-bottom-edge: full-page screenshot: 312 pixels (ratio 0.01 of all image pixels) are different`;
const ID = 'dark pages.visual.ts::dashboard/stage-menu-bottom-edge: full-page screenshot';

describe('extractFailingTestIds', () => {
  it('normalizes the visual gate line and the playwright failure line to the same id', () => {
    expect(extractFailingTestIds(GATE)).toEqual([ID]);
    expect(extractFailingTestIds(LIST)).toEqual([ID]);
    expect(extractFailingTestIds(`${LIST}\n${GATE}\n`)).toEqual([ID]);
  });

  it('does not read the per-test ✘ line (a flaky test passes on retry)', () => {
    expect(extractFailingTestIds(CROSS)).toEqual([]);
  });

  it('reads the backticked project of the gate summary and the diff-size-unavailable tail', () => {
    expect(extractFailingTestIds('- `dark` pages.visual.ts::a/b: full-page screenshot: diff size unavailable')).toEqual(['dark pages.visual.ts::a/b: full-page screenshot']);
  });

  it('keeps a title with no diff tail whole', () => {
    expect(extractFailingTestIds('- light pages.visual.ts::x: y')).toEqual(['light pages.visual.ts::x: y']);
  });

  it('strips ANSI colour from a line', () => {
    expect(extractFailingTestIds(`\u001b[31m${GATE.slice(P.length + 29)}\u001b[0m`)).toEqual([ID]);
  });

  it('does not read an indented "- Expect" line or a line without ::', () => {
    expect(extractFailingTestIds('      - Expect "toHaveScreenshot(a.png)" with timeout 5000ms')).toEqual([]);
    expect(extractFailingTestIds('- dark pages.visual.ts a title')).toEqual([]);
  });

  it('reads a playwright failure line without tags and with a timing', () => {
    expect(extractFailingTestIds('  12) [light] › tests/x/a.spec.ts:3:9 › suite › leaf name (2.3s)')).toEqual(['light a.spec.ts::leaf name']);
  });

  it('extracts a vitest FAIL line, with and without a project and a timing', () => {
    expect(extractFailingTestIds(' FAIL  src/a.test.ts > suite > does a thing')).toEqual(['vitest src/a.test.ts > suite > does a thing']);
    expect(extractFailingTestIds(' FAIL  |unit| src/a.test.ts > b 12ms')).toEqual(['vitest src/a.test.ts > b']);
  });

  it('does not read a vitest file-level FAIL line without a test name', () => {
    expect(extractFailingTestIds(' FAIL  src/a.test.ts [ src/a.test.ts ]')).toEqual([]);
  });

  it('gives [] for a log with no failing-test line', () => {
    expect(extractFailingTestIds('##[error]Process completed with exit code 1.\nnpm error code 1\n')).toEqual([]);
    expect(extractFailingTestIds('')).toEqual([]);
  });

  it('sorts and removes duplicates', () => {
    const log = ' FAIL  src/b.test.ts > z\n FAIL  src/a.test.ts > y\n FAIL  src/b.test.ts > z\n';
    expect(extractFailingTestIds(log)).toEqual(['vitest src/a.test.ts > y', 'vitest src/b.test.ts > z']);
  });

  it('reads only the bounded tail of a long log', () => {
    const log = ` FAIL  src/old.test.ts > gone\n${'x'.repeat(200_001)}\n FAIL  src/new.test.ts > kept\n`;
    expect(extractFailingTestIds(log)).toEqual(['vitest src/new.test.ts > kept']);
  });
});

describe('isBaseRed', () => {
  it('is true only when the base set holds every PR id', () => {
    expect(isBaseRed(['a'], ['a', 'b'])).toBe(true);
    expect(isBaseRed(['a', 'b'], ['a', 'b'])).toBe(true);
    expect(isBaseRed(['a', 'c'], ['a', 'b'])).toBe(false);
    expect(isBaseRed(['a'], null)).toBe(false);
  });

  it('is false for an empty PR set', () => {
    expect(isBaseRed([], ['a'])).toBe(false);
  });
});

describe('isBaseRedPattern', () => {
  it('names both marker prefixes and nothing else', () => {
    expect(BASE_RED_PREFIX).toBe('base-red:');
    expect(BASE_RED_WAIT_PREFIX).toBe('base-red-wait:');
    expect(isBaseRedPattern('base-red:develop')).toBe(true);
    expect(isBaseRedPattern('base-red-wait:100')).toBe(true);
    expect(isBaseRedPattern('stale-generated:npm run x')).toBe(false);
    expect(isBaseRedPattern('no-change')).toBe(false);
  });
});
