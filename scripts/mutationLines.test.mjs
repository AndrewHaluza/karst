import { describe, expect, it } from 'vitest';
import { concurrencyFor, joinNearRanges, linesMarkdown, mutateSpecs, parseDiffRanges, verdictOnAddedLines } from './mutationLines.mjs';

const hunk = (file, ...heads) => [`diff --git a/${file} b/${file}`, `--- a/${file}`, `+++ b/${file}`, ...heads.flatMap((h) => [h, '+x'])].join('\n');

describe('parseDiffRanges', () => {
  it('reads one range per hunk, a count of 1 when the count is absent', () => {
    const diff = hunk('a.ts', '@@ -1,0 +5,3 @@ fn', '@@ -9 +20 @@');
    expect(parseDiffRanges(diff)).toEqual(new Map([['a.ts', [[5, 7], [20, 20]]]]));
  });

  it('drops a delete-only hunk and a deleted file', () => {
    const diff = [hunk('a.ts', '@@ -4,2 +3,0 @@'), 'diff --git a/b.ts b/b.ts', '--- a/b.ts', '+++ /dev/null', '@@ -1,2 +0,0 @@'].join('\n');
    expect(parseDiffRanges(diff)).toEqual(new Map());
  });

  it('keys a rename by the new path and keeps only the added lines', () => {
    const diff = ['diff --git a/old.ts b/new.ts', 'similarity index 90%', 'rename from old.ts', 'rename to new.ts', '--- a/old.ts', '+++ b/new.ts\t', '@@ -3 +3,2 @@'].join('\n');
    expect(parseDiffRanges(diff)).toEqual(new Map([['new.ts', [[3, 4]]]]));
  });

  it('keeps several files apart and joins the hunks of one file', () => {
    const diff = [hunk('a.ts', '@@ -1 +1 @@'), hunk('b.ts', '@@ -1 +2,2 @@'), hunk('a.ts', '@@ -9 +9 @@')].join('\n');
    expect(parseDiffRanges(diff).get('a.ts')).toEqual([[1, 1], [9, 9]]);
    expect(parseDiffRanges(diff).get('b.ts')).toEqual([[2, 3]]);
  });

  it('ignores a hunk line before any file header', () => {
    expect(parseDiffRanges('@@ -1 +1 @@\n')).toEqual(new Map());
  });
});

describe('joinNearRanges', () => {
  it('joins two ranges with at most 3 unchanged lines between them', () => {
    expect(joinNearRanges([[1, 2], [6, 7]])).toEqual([[1, 7]]);
  });
  it('keeps two ranges with 4 unchanged lines between them apart', () => {
    expect(joinNearRanges([[1, 2], [7, 8]])).toEqual([[1, 2], [7, 8]]);
  });
  it('sorts the input, merges an overlap and does not change it', () => {
    const input = [[10, 12], [1, 3], [2, 5]];
    expect(joinNearRanges(input)).toEqual([[1, 5], [10, 12]]);
    expect(input).toEqual([[10, 12], [1, 3], [2, 5]]);
  });
  it('honours a gap argument', () => {
    expect(joinNearRanges([[1, 1], [3, 3]], 0)).toEqual([[1, 1], [3, 3]]);
  });
});

describe('mutateSpecs', () => {
  it('builds file:a-b specs, a bare path for a whole file, sorted by path', () => {
    const specs = mutateSpecs(new Map([['b.ts', [[1, 2], [9, 9]]], ['a.ts', null]]));
    expect(specs).toEqual(['a.ts', 'b.ts:1-2', 'b.ts:9-9']);
  });
});

const mutant = (line, status, extra = {}) => ({ id: `${line}`, mutatorName: 'ConditionalExpression', replacement: 'true', status, location: { start: { line, column: 3 }, end: { line, column: 9 } }, ...extra });
const report = (mutants) => ({ files: { 'a.ts': { mutants } } });
const ranges = new Map([['a.ts', [[10, 20]]]]);

describe('verdictOnAddedLines', () => {
  it('fails Survived and NoCoverage inside a range', () => {
    const v = verdictOnAddedLines(report([mutant(12, 'Survived'), mutant(13, 'NoCoverage')]), ranges);
    expect(v.failures.map((f) => f.status)).toEqual(['Survived', 'NoCoverage']);
  });
  it('passes a Survived mutant outside every range', () => {
    expect(verdictOnAddedLines(report([mutant(30, 'Survived'), mutant(9, 'Survived')]), ranges).failures).toEqual([]);
  });
  it('treats a range edge as inside', () => {
    expect(verdictOnAddedLines(report([mutant(10, 'Survived'), mutant(20, 'Survived')]), ranges).failures).toHaveLength(2);
  });
  it('passes Killed, Timeout, RuntimeError, CompileError and Ignored', () => {
    const ms = ['Killed', 'Timeout', 'RuntimeError', 'CompileError', 'Ignored'].map((s, i) => mutant(11 + i, s));
    expect(verdictOnAddedLines(report(ms), ranges).failures).toEqual([]);
  });
  it('fails Pending and an unknown status', () => {
    const v = verdictOnAddedLines(report([mutant(11, 'Pending'), mutant(12, 'Weird')]), ranges);
    expect(v.failures.map((f) => f.status)).toEqual(['Pending', 'Weird']);
  });
  it('counts Ignored by reason', () => {
    const ms = [mutant(11, 'Ignored', { statusReason: 'Static mutant (and "ignoreStatic" was enabled)' }), mutant(12, 'Ignored', { statusReason: 'Stryker disable next-line: why' }), mutant(13, 'Ignored')];
    expect(verdictOnAddedLines(report(ms), ranges).ignored).toEqual({ static: 1, disabled: 2 });
  });
  it('judges a whole file when its ranges are null and skips a file that is not in the map', () => {
    const r = { files: { 'a.ts': { mutants: [mutant(500, 'Survived')] }, 'z.ts': { mutants: [mutant(1, 'Survived')] } } };
    expect(verdictOnAddedLines(r, new Map([['a.ts', null]])).failures).toHaveLength(1);
  });
  it('counts judged mutants', () => {
    expect(verdictOnAddedLines(report([mutant(11, 'Killed'), mutant(40, 'Killed')]), ranges).judged).toBe(1);
  });
});

describe('linesMarkdown', () => {
  it('prints a pass line and the ignored split', () => {
    const text = linesMarkdown({ failures: [], ignored: { static: 2, disabled: 1 }, judged: 4 });
    expect(text).toContain('4 mutants on added lines, none undetected');
    expect(text).toContain('Ignored on added lines: 3 (2 static, 1 Stryker disable)');
  });
  it('prints one row per failure', () => {
    const f = { file: 'a.ts', line: 12, mutator: 'ConditionalExpression', replacement: 'true', status: 'Survived' };
    const text = linesMarkdown({ failures: [f], ignored: { static: 0, disabled: 0 }, judged: 1 });
    expect(text).toContain('| a.ts:12 | ConditionalExpression | `true` | Survived |');
    expect(text).toContain('1 undetected');
  });
  it('escapes a backslash and a pipe, and joins whitespace, in the replacement cell', () => {
    const f = { file: 'a.ts', line: 1, mutator: 'StringLiteral', replacement: 'a\\b | c\n  d', status: 'Survived' };
    const text = linesMarkdown({ failures: [f], ignored: { static: 0, disabled: 0 }, judged: 1 });
    expect(text).toContain('`a\\\\b \\| c d`');
  });
});

describe('concurrencyFor', () => {
  it('uses half the cores, at least 1 and at most 4', () => {
    expect(concurrencyFor(10, {})).toBe(4);
    expect(concurrencyFor(6, {})).toBe(3);
    expect(concurrencyFor(1, {})).toBe(1);
  });
  it('is 1 under KARST_GATE_MAX_WORKERS=1', () => {
    expect(concurrencyFor(10, { KARST_GATE_MAX_WORKERS: '1' })).toBe(1);
  });
  it('ignores another KARST_GATE_MAX_WORKERS value', () => {
    expect(concurrencyFor(10, { KARST_GATE_MAX_WORKERS: '2' })).toBe(4);
  });
});
