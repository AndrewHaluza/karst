import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { evaluate, parseArgs, run, validateReport } from './mutationGate.mjs';

const dirs = [];
function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'mutation-gate-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const SOURCE = 'export function ok(x) {\n  return x === 1;\n}\n';

/** One mutant in the verbatim Stryker JSON shape (schemaVersion 1.0). */
function mutant(id, status) {
  return {
    id: String(id),
    mutatorName: 'EqualityOperator',
    replacement: 'x !== 1',
    status,
    static: false,
    location: { start: { line: 2, column: 10 }, end: { line: 2, column: 16 } },
  };
}

/** A file with the given counts of each status. */
function file(counts) {
  const mutants = [];
  let id = 0;
  for (const [status, n] of Object.entries(counts)) {
    for (let i = 0; i < n; i++) mutants.push(mutant(id++, status));
  }
  return { language: 'typescript', source: SOURCE, mutants };
}

function report(files) {
  return { schemaVersion: '1.0', thresholds: { high: 85, low: 75, break: 85 }, files };
}

function setup({ pr, develop, changed, config }) {
  const dir = tempDir();
  const paths = {
    reportPath: join(dir, 'pr.json'),
    developReportPath: join(dir, 'develop.json'),
    changedPath: join(dir, 'changed.txt'),
    configPath: join(dir, 'stryker.config.json'),
    summaryPath: join(dir, 'summary.md'),
  };
  const raw = (value) => (typeof value === 'string' ? value : JSON.stringify(value));
  if (pr !== undefined) writeFileSync(paths.reportPath, raw(pr));
  if (develop !== undefined) writeFileSync(paths.developReportPath, raw(develop));
  writeFileSync(paths.changedPath, (changed ?? []).join('\n'));
  writeFileSync(paths.configPath, JSON.stringify(config ?? { thresholds: { break: 85 } }));
  return paths;
}

const A = 'src/extension/a.ts';
const B = 'src/extension/b.ts';

describe('rule 3a: file in the develop report', () => {
  it('fails when the PR has more undetected mutants than develop', () => {
    const paths = setup({
      pr: report({ [A]: file({ Killed: 9, Survived: 2, NoCoverage: 1 }) }),
      develop: report({ [A]: file({ Killed: 9, Survived: 1, NoCoverage: 1 }) }),
      changed: [A],
    });
    const result = run(paths);
    expect(result.exitCode).toBe(1);
    expect(result.markdown).toContain(`| \`${A}\` | 2 | 3 | 75.00 | FAIL: 1 more undetected than develop |`);
  });

  it('passes at an equal count even when the file score is below the break', () => {
    const paths = setup({
      pr: report({ [A]: file({ Killed: 1, Survived: 3 }) }),
      develop: report({ [A]: file({ Killed: 5, Survived: 3 }) }),
      changed: [A],
    });
    const result = run(paths);
    expect(result.exitCode).toBe(0);
    expect(result.markdown).toContain(`| \`${A}\` | 3 | 3 | 25.00 | pass |`);
  });

  it('passes when the PR has fewer undetected mutants', () => {
    const paths = setup({
      pr: report({ [A]: file({ Killed: 9, Survived: 1 }) }),
      develop: report({ [A]: file({ Killed: 5, Survived: 5 }) }),
      changed: [A],
    });
    expect(run(paths).exitCode).toBe(0);
  });

  it('counts NoCoverage as undetected and Timeout/Ignored as not', () => {
    const paths = setup({
      pr: report({ [A]: file({ Killed: 8, NoCoverage: 1, Timeout: 3, Ignored: 4 }) }),
      develop: report({ [A]: file({ Killed: 8, Timeout: 3 }) }),
      changed: [A],
    });
    expect(run(paths).exitCode).toBe(1);
  });

  it('ignores a file the PR did not change, even when it got worse', () => {
    const paths = setup({
      pr: report({ [A]: file({ Killed: 1, Survived: 9 }), [B]: file({ Killed: 10 }) }),
      develop: report({ [A]: file({ Killed: 10 }), [B]: file({ Killed: 10 }) }),
      changed: [B],
    });
    const result = run(paths);
    expect(result.exitCode).toBe(0);
    expect(result.markdown).not.toContain(A);
  });

  it('ignores a changed file outside the mutate set (absent from the PR report)', () => {
    const paths = setup({
      pr: report({ [A]: file({ Killed: 10 }) }),
      develop: report({ [A]: file({ Killed: 10 }) }),
      changed: ['src/extension/secrets.ts', 'README.md'],
    });
    const result = run(paths);
    expect(result.exitCode).toBe(0);
    expect(result.markdown).toContain('No changed file is in the Stryker `mutate` set.');
  });
});

describe('rule 3b: new file', () => {
  it('fails a new file whose score is below the break', () => {
    const paths = setup({
      pr: report({ [A]: file({ Killed: 5, Survived: 1 }), [B]: file({ Killed: 10 }) }),
      develop: report({ [B]: file({ Killed: 10 }) }),
      changed: [A],
    });
    const result = run(paths);
    expect(result.exitCode).toBe(1);
    expect(result.markdown).toContain(`| \`${A}\` | n/a | 1 | 83.33 | FAIL: new file, score below 85 |`);
  });

  it('passes a new file at exactly the break score', () => {
    const paths = setup({
      pr: report({ [A]: file({ Killed: 17, Survived: 3 }) }),
      develop: report({ [B]: file({ Killed: 10 }) }),
      changed: [A],
    });
    expect(run(paths).exitCode).toBe(0);
  });

  it('uses the break threshold from the Stryker config', () => {
    const paths = setup({
      pr: report({ [A]: file({ Killed: 9, Survived: 1 }) }),
      develop: report({}),
      changed: [A],
      config: { thresholds: { break: 95 } },
    });
    expect(run(paths).exitCode).toBe(1);
  });

  it('passes a new file with no valid mutants', () => {
    const paths = setup({
      pr: report({ [A]: file({ Ignored: 2 }) }),
      develop: report({}),
      changed: [A],
    });
    const result = run(paths);
    expect(result.exitCode).toBe(0);
    expect(result.markdown).toContain('pass (no mutants)');
  });
});

describe('a renamed file', () => {
  it('treats the new path as new and ignores the old path', () => {
    const OLD = 'src/extension/old.ts';
    const paths = setup({
      pr: report({ [A]: file({ Killed: 6, Survived: 4 }) }),
      develop: report({ [OLD]: file({ Killed: 6, Survived: 4 }) }),
      changed: [OLD, A],
    });
    const result = run(paths);
    expect(result.exitCode).toBe(1);
    expect(result.markdown).toContain('FAIL: new file, score below 85');
    expect(result.markdown).not.toContain(OLD);
  });

  it('passes a renamed file that is clean', () => {
    const OLD = 'src/extension/old.ts';
    const paths = setup({
      pr: report({ [A]: file({ Killed: 10 }) }),
      develop: report({ [OLD]: file({ Killed: 5, Survived: 5 }) }),
      changed: [OLD, A],
    });
    expect(run(paths).exitCode).toBe(0);
  });
});

describe('rule 4: no develop report', () => {
  it('applies rule 3b to every changed file when the path is absent', () => {
    const paths = setup({
      pr: report({ [A]: file({ Killed: 5, Survived: 5 }), [B]: file({ Killed: 10 }) }),
      changed: [A, B],
    });
    const result = run({ ...paths, developReportPath: undefined });
    expect(result.exitCode).toBe(1);
    expect(result.markdown).toContain('No develop mutation report is available');
    expect(result.markdown).toContain(`| \`${B}\` | n/a | 0 | 100.00 | pass (new file) |`);
  });

  it('applies rule 3b when the develop file does not exist', () => {
    const paths = setup({ pr: report({ [A]: file({ Killed: 10 }) }), changed: [A] });
    expect(run(paths).exitCode).toBe(0);
  });

  it('does not fall back to the global score', () => {
    // Global score is 50 (below 85), but the changed file is clean.
    const paths = setup({
      pr: report({ [A]: file({ Killed: 10 }), [B]: file({ Survived: 10 }) }),
      changed: [A],
    });
    expect(run(paths).exitCode).toBe(0);
  });

  it('applies rule 3b when the develop report is malformed JSON', () => {
    const paths = setup({
      pr: report({ [A]: file({ Killed: 5, Survived: 5 }) }),
      develop: '{ not json',
      changed: [A],
    });
    const result = run(paths);
    expect(result.exitCode).toBe(1);
    expect(result.markdown).toContain('Develop report');
    expect(result.markdown).toContain('is not valid JSON');
  });

  it('applies rule 3b when the develop report has no files object', () => {
    const paths = setup({
      pr: report({ [A]: file({ Killed: 10 }) }),
      develop: { schemaVersion: '1.0' },
      changed: [A],
    });
    const result = run(paths);
    expect(result.exitCode).toBe(0);
    expect(result.markdown).toContain('Develop report: the mutation report is malformed');
  });

  it('applies rule 3b when a develop file entry has no mutants array', () => {
    const paths = setup({
      pr: report({ [A]: file({ Killed: 5, Survived: 5 }) }),
      develop: report({ [A]: null }),
      changed: [A],
    });
    expect(run(paths).exitCode).toBe(1);
  });
});

describe('a missing or malformed PR report', () => {
  it('fails closed when the PR report is missing', () => {
    const paths = setup({ develop: report({ [A]: file({ Killed: 10 }) }), changed: [A] });
    const result = run(paths);
    expect(result.exitCode).toBe(1);
    expect(result.annotations[0]).toMatch(/^::error::PR report: No mutation report/);
  });

  it('fails closed when the PR report is malformed JSON', () => {
    const paths = setup({ pr: 'oops', develop: report({}), changed: [A] });
    const result = run(paths);
    expect(result.exitCode).toBe(1);
    expect(result.markdown).toContain('is not valid JSON');
  });

  it('fails closed when the PR report has a null file entry', () => {
    const paths = setup({ pr: report({ [A]: null }), develop: report({}), changed: [A] });
    const result = run(paths);
    expect(result.exitCode).toBe(1);
    expect(result.markdown).toContain(`the entry for \`${A}\` has no \`mutants\` array`);
  });

  it('fails closed when files is an array', () => {
    const paths = setup({ pr: { files: [] }, changed: [A] });
    expect(run(paths).exitCode).toBe(1);
  });
});

describe('rule 5: global score', () => {
  const lowGlobal = () =>
    setup({
      pr: report({ [A]: file({ Killed: 10 }), [B]: file({ Killed: 1, Survived: 9 }) }),
      develop: report({ [A]: file({ Killed: 10 }), [B]: file({ Killed: 1, Survived: 9 }) }),
      changed: [A],
    });

  it('warns and writes a summary line, but passes', () => {
    const paths = lowGlobal();
    const result = run(paths);
    expect(result.exitCode).toBe(0);
    expect(result.annotations).toEqual([
      '::warning::Global mutation score 55.00 is below thresholds.break (85). This does not fail the PR.',
    ]);
    const summary = readFileSync(paths.summaryPath, 'utf8');
    expect(summary).toContain('Global mutation score 55.00 is below thresholds.break (85)');
  });

  it('adds no warning when the global score meets the break', () => {
    const paths = setup({
      pr: report({ [A]: file({ Killed: 10 }) }),
      develop: report({ [A]: file({ Killed: 10 }) }),
      changed: [A],
    });
    const result = run(paths);
    expect(result.annotations).toEqual([]);
    expect(result.markdown).toContain('Global mutation score: 100.00 (break 85).');
  });
});

describe('summary table (rule 6)', () => {
  it('lists develop undetected, PR undetected, file score and verdict per changed file', () => {
    const paths = setup({
      pr: report({ [A]: file({ Killed: 9, Survived: 1 }), [B]: file({ Killed: 10 }) }),
      develop: report({ [A]: file({ Killed: 9, Survived: 1 }) }),
      changed: [A, B],
    });
    const result = run(paths);
    const summary = readFileSync(paths.summaryPath, 'utf8');
    expect(summary).toBe(`${result.markdown}\n`);
    expect(result.markdown).toContain('| File | Develop undetected | PR undetected | File score | Verdict |');
    expect(result.markdown).toContain(`| \`${A}\` | 1 | 1 | 90.00 | pass |`);
    expect(result.markdown).toContain(`| \`${B}\` | n/a | 0 | 100.00 | pass (new file) |`);
  });

  it('lists a changed file once, normalizing a leading ./', () => {
    const rows = evaluate({
      prFiles: report({ [A]: file({ Killed: 10 }) }).files,
      developFiles: null,
      changedFiles: [A, `./${A}`],
      threshold: 85,
    });
    expect(rows).toHaveLength(1);
  });

  it('does not throw when the summary path is unwritable', () => {
    const paths = setup({ pr: report({ [A]: file({ Killed: 10 }) }), changed: [A] });
    expect(run({ ...paths, summaryPath: join(paths.summaryPath, 'nope', 'x.md') }).exitCode).toBe(0);
  });
});

describe('validateReport and parseArgs', () => {
  it('accepts a report with a files object', () => {
    expect(validateReport(report({ [A]: file({ Killed: 1 }) }))).toBeNull();
    expect(validateReport(report({}))).toBeNull();
  });

  it('rejects a missing report and a non-array mutants field', () => {
    expect(validateReport(null)).toMatch(/no `files` object/);
    expect(validateReport({ files: { [A]: { mutants: {} } } })).toMatch(/mutants/);
  });

  it('parses the CLI flags', () => {
    expect(
      parseArgs([
        '--report', 'p.json',
        '--develop-report', 'd.json',
        '--config', 'c.json',
        '--changed', 'ch.txt',
        '--summary', 's.md',
      ]),
    ).toEqual({
      reportPath: 'p.json',
      developReportPath: 'd.json',
      configPath: 'c.json',
      changedPath: 'ch.txt',
      summaryPath: 's.md',
    });
  });
});
