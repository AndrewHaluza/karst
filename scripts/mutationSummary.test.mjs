import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildAnnotations,
  buildMiniReport,
  extractOriginal,
  fileMetrics,
  loadThreshold,
  run,
} from './mutationSummary.mjs';

const dirs = [];
function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'mutation-summary-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Build a 1-based Stryker location for the first occurrence of `snippet`. */
function locAt(source, snippet) {
  const start = source.indexOf(snippet);
  if (start < 0) throw new Error(`snippet not in source: ${snippet}`);
  const line = (offset) => source.slice(0, offset).split('\n').length;
  const column = (offset) => offset - (source.lastIndexOf('\n', offset - 1) + 1) + 1;
  const end = start + snippet.length;
  return {
    start: { line: line(start), column: column(start) },
    end: { line: line(end), column: column(end) },
  };
}

function mutant(source, snippet, overrides) {
  return {
    id: snippet,
    mutatorName: 'ConditionalExpression',
    replacement: '/* x */',
    status: 'Survived',
    location: locAt(source, snippet),
    ...overrides,
  };
}

const WORSE = 'export function ok(x) {\n  return x === 1;\n}\n';
const BAD = 'const a = 1;\nconst b = a > 0;\nconst c = b ? "x" : "y";\n';
const GOOD = 'export const n = 2;\n';

function fixture() {
  return {
    schemaVersion: '1.0',
    thresholds: { high: 85, low: 75, break: 85 },
    files: {
      'src/extension/worse.ts': {
        language: 'typescript',
        source: WORSE,
        mutants: [
          mutant(WORSE, 'x === 1', {
            mutatorName: 'EqualityOperator',
            replacement: 'x !== 1',
          }),
        ],
      },
      'src/extension/bad.ts': {
        language: 'typescript',
        source: BAD,
        mutants: [
          mutant(BAD, '1', { mutatorName: 'NumericLiteral', replacement: '0', status: 'Killed' }),
          mutant(BAD, 'a > 0', {
            mutatorName: 'ConditionalExpression',
            replacement: 'a >= 0',
            status: 'Survived',
          }),
          mutant(BAD, '"x"', {
            mutatorName: 'StringLiteral',
            replacement: '""',
            status: 'NoCoverage',
          }),
        ],
      },
      'src/extension/good.ts': {
        language: 'typescript',
        source: GOOD,
        mutants: [
          mutant(GOOD, '2', { mutatorName: 'NumericLiteral', replacement: '3', status: 'Killed' }),
        ],
      },
    },
  };
}

describe('extractOriginal', () => {
  it('slices the original code using 1-based line and column', () => {
    expect(extractOriginal(BAD, locAt(BAD, 'a > 0'))).toBe('a > 0');
    expect(extractOriginal(BAD, locAt(BAD, '"x"'))).toBe('"x"');
  });

  it('returns empty when the source is absent', () => {
    expect(extractOriginal(undefined, locAt(BAD, 'a > 0'))).toBe('');
  });
});

describe('fileMetrics', () => {
  it('scores detected over valid, counting Timeout as killed', () => {
    const metrics = fileMetrics([
      { status: 'Killed' },
      { status: 'Timeout' },
      { status: 'Survived' },
      { status: 'NoCoverage' },
    ]);
    expect(metrics).toMatchObject({ killed: 2, survived: 1, noCoverage: 1, valid: 4 });
    expect(metrics.score).toBeCloseTo(50);
  });

  it('reports a null score when there are no valid mutants', () => {
    expect(fileMetrics([{ status: 'Ignored' }]).score).toBeNull();
  });
});

describe('buildMiniReport', () => {
  it('shows the overall score against the threshold and excludes passing files', () => {
    const markdown = buildMiniReport({ report: fixture(), threshold: 85 });
    expect(markdown).toContain('**Overall: 40.00%** ❌ (break threshold 85.00%)');
    expect(markdown).toContain(
      '| `src/extension/worse.ts` | 0.00% | 0 | 1 | 0 |',
    );
    expect(markdown).toContain('| `src/extension/bad.ts` | 33.33% | 1 | 1 | 1 |');
    expect(markdown).not.toContain('good.ts');
  });

  it('orders the table worst-first', () => {
    const markdown = buildMiniReport({ report: fixture(), threshold: 85 });
    expect(markdown.indexOf('worse.ts')).toBeLessThan(markdown.indexOf('bad.ts'));
  });

  it('lists surviving mutants as file:line . mutator . original -> replacement', () => {
    const markdown = buildMiniReport({ report: fixture(), threshold: 85 });
    expect(markdown).toContain(
      '- `src/extension/bad.ts:2` · ConditionalExpression · `a > 0` → `a >= 0`',
    );
    expect(markdown).toContain(
      '- `src/extension/bad.ts:3` · StringLiteral · `"x"` → `""`',
    );
  });

  it('caps the per-file mutant list at five', () => {
    const source = Array.from({ length: 8 }, (_, i) => `field${i} = 0;`).join('\n');
    const report = {
      files: {
        'src/extension/many.ts': {
          source,
          mutants: Array.from({ length: 8 }, (_, i) =>
            mutant(source, `field${i}`, { replacement: 'x', status: 'Survived' }),
          ),
        },
      },
    };
    const bullets = buildMiniReport({ report, threshold: 85 }).match(/^- `/gm) ?? [];
    expect(bullets).toHaveLength(5);
  });

  it('says so when every file clears the threshold', () => {
    const report = {
      files: {
        'src/extension/good.ts': {
          source: GOOD,
          mutants: [mutant(GOOD, '2', { status: 'Killed' })],
        },
      },
    };
    const markdown = buildMiniReport({ report, threshold: 85 });
    expect(markdown).toContain('**Overall: 100.00%** ✅');
    expect(markdown).toContain('No file is below the 85.00% break threshold.');
  });
});

describe('buildAnnotations', () => {
  it('only annotates mutants in files the PR changed', () => {
    const annotations = buildAnnotations({
      report: fixture(),
      changedFiles: ['src/extension/worse.ts'],
    });
    expect(annotations).toEqual([
      '::warning file=src/extension/worse.ts,line=2,title=Mutant survived::EqualityOperator: x === 1 → x !== 1',
    ]);
  });

  it('uses a distinct title for no-coverage mutants', () => {
    const annotations = buildAnnotations({
      report: fixture(),
      changedFiles: ['src/extension/bad.ts'],
    });
    expect(annotations).toContainEqual(
      '::warning file=src/extension/bad.ts,line=3,title=Mutant not covered::StringLiteral: "x" → ""',
    );
  });

  it('goes worst files first and stops at ten annotations', () => {
    const source = Array.from({ length: 12 }, (_, i) => `field${i} = 0;`).join('\n');
    const report = {
      files: {
        'src/extension/many.ts': {
          source,
          mutants: Array.from({ length: 12 }, (_, i) =>
            mutant(source, `field${i}`, { replacement: 'x', status: 'Survived' }),
          ),
        },
      },
    };
    const annotations = buildAnnotations({
      report,
      changedFiles: ['src/extension/many.ts'],
    });
    expect(annotations).toHaveLength(10);
    expect(annotations[0]).toContain('line=1');
    expect(annotations[9]).toContain('line=10');
  });

  it('escapes commas in the file path property', () => {
    const report = {
      files: {
        'src/weird,file.ts': {
          source: 'const x = 1;\n',
          mutants: [mutant('const x = 1;\n', '1', { status: 'Survived' })],
        },
      },
    };
    const annotations = buildAnnotations({
      report,
      changedFiles: ['src/weird,file.ts'],
    });
    expect(annotations[0]).toContain('file=src/weird%2Cfile.ts,line=1');
  });
});

describe('loadThreshold', () => {
  it('reads thresholds.break from the Stryker config', () => {
    const dir = tempDir();
    const config = join(dir, 'stryker.config.json');
    writeFileSync(config, JSON.stringify({ thresholds: { break: 90 } }));
    expect(loadThreshold(config, null)).toBe(90);
  });

  it('falls back to the report thresholds when the config is unreadable', () => {
    const dir = tempDir();
    const missing = join(dir, 'nope.json');
    expect(loadThreshold(missing, { thresholds: { break: 70 } })).toBe(70);
    expect(loadThreshold(missing, {})).toBeNull();
  });
});

describe('run', () => {
  it('writes the summary and returns annotations for a valid report', () => {
    const dir = tempDir();
    const reportPath = join(dir, 'mutation.json');
    const configPath = join(dir, 'stryker.config.json');
    const changedPath = join(dir, 'changed.txt');
    const summaryPath = join(dir, 'summary.md');
    writeFileSync(reportPath, JSON.stringify(fixture()));
    writeFileSync(configPath, JSON.stringify({ thresholds: { break: 85 } }));
    writeFileSync(changedPath, 'src/extension/worse.ts\n');

    const result = run({ reportPath, configPath, changedPath, summaryPath });

    expect(result.exitCode).toBe(0);
    expect(result.annotations).toHaveLength(1);
    expect(readFileSync(summaryPath, 'utf8')).toContain('**Overall: 40.00%** ❌');
  });

  it('degrades to a message when the report is missing', () => {
    const dir = tempDir();
    const summaryPath = join(dir, 'summary.md');
    const result = run({
      reportPath: join(dir, 'absent.json'),
      configPath: join(dir, 'absent.config.json'),
      summaryPath,
    });
    expect(result.exitCode).toBe(0);
    expect(result.markdown).toContain('No mutation report');
    expect(readFileSync(summaryPath, 'utf8')).toContain('No mutation report');
  });

  it('degrades to a message when the report is invalid JSON', () => {
    const dir = tempDir();
    const reportPath = join(dir, 'mutation.json');
    writeFileSync(reportPath, '{ not json');
    const result = run({ reportPath, configPath: join(dir, 'absent.json') });
    expect(result.exitCode).toBe(0);
    expect(result.markdown).toContain('is not valid JSON');
  });

  it('does not annotate when disabled', () => {
    const dir = tempDir();
    const reportPath = join(dir, 'mutation.json');
    writeFileSync(reportPath, JSON.stringify(fixture()));
    const result = run({ reportPath, annotate: false });
    expect(result.annotations).toEqual([]);
  });
});
