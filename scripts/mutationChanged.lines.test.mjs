import { describe, expect, it, vi } from 'vitest';
import { linesArgs, mutationLines } from './mutationChanged.mjs';

const PATTERNS = ['src/extension/**/*.ts', '!src/extension/**/*.test.ts'];
const DIFF = ['diff --git a/src/extension/a.ts b/src/extension/a.ts', '--- a/src/extension/a.ts', '+++ b/src/extension/a.ts', '@@ -1 +10,2 @@', '@@ -5 +30 @@',
  'diff --git a/docs/x.md b/docs/x.md', '--- a/docs/x.md', '+++ b/docs/x.md', '@@ -1 +1 @@'].join('\n');
const survived = { files: { 'src/extension/a.ts': { mutants: [{ id: '1', mutatorName: 'BooleanLiteral', replacement: 'false', status: 'Survived', location: { start: { line: 10, column: 1 }, end: { line: 10, column: 4 } } }] } } };
const killed = { files: { 'src/extension/a.ts': { mutants: [{ id: '1', mutatorName: 'BooleanLiteral', replacement: 'false', status: 'Killed', location: { start: { line: 10, column: 1 }, end: { line: 10, column: 4 } } }] } } };

const deps = (over = {}) => {
  const out = [];
  const gitCalls = [];
  const base = {
    cwd: '/w',
    mergeBaseFn: async () => ({ sha: 'abcdef0123456789', tried: ['develop'] }),
    gitFn: async (_cwd, args) => {
      gitCalls.push(args);
      if (args[0] === 'diff') return DIFF;
      if (args[0] === 'ls-files') return 'src/extension/new.ts\0README.md\0';
      return '/w/.git\n';
    },
    patterns: PATTERNS,
    exists: () => true,
    resolveBin: () => '/nm/stryker.js',
    spawnFn: vi.fn(async () => ({ status: 0, out: '' })),
    driftFn: vi.fn(async () => 1),
    readReport: () => killed,
    removeReport: vi.fn(),
    prepare: vi.fn(),
    cpus: 10,
    env: {},
    log: (line) => out.push(line),
    print: (text) => out.push(text),
    ignorePatterns: ['reports'],
  };
  return { d: { ...base, ...over }, out, gitCalls };
};

describe('linesArgs', () => {
  it('holds the specs, the state file, the report, the reporters and the concurrency', () => {
    const args = linesArgs({ configFile: 'c.json', specs: ['a.ts:1-2'], stateFile: '/g/karst-gate-state/stryker-lines.json', concurrency: 4, ignorePatterns: ['reports', 'docs'], full: false });
    expect(args).toEqual(expect.arrayContaining(['--mutate', 'a.ts:1-2', '--incremental', '--incrementalFile', '/g/karst-gate-state/stryker-lines.json', '--reporters', 'json,progress-append-only', '--concurrency', '4']));
    expect(args.slice(0, 2)).toEqual(['run', 'c.json']);
    expect(args).not.toContain('--force');
    expect(args).not.toContain('--inPlace');
    expect(args).not.toContain('--allowEmpty');
    expect(args).not.toContain('--testFiles');
    expect(args[args.indexOf('--ignorePatterns') + 1]).toBe('reports,docs');
  });
  it('adds --logLevel when asked, so the dry-run test count can be read', () => {
    const args = linesArgs({ configFile: 'c.json', specs: ['a.ts'], stateFile: 's', concurrency: 1, ignorePatterns: [], full: false, logLevel: 'info' });
    expect(args.slice(-2)).toEqual(['--logLevel', 'info']);
    expect(linesArgs({ configFile: 'c.json', specs: ['a.ts'], stateFile: 's', concurrency: 1, ignorePatterns: [], full: false })).not.toContain('--logLevel');
  });
  it('adds --force for a full run', () => {
    expect(linesArgs({ configFile: 'c.json', specs: ['a.ts'], stateFile: 's', concurrency: 1, ignorePatterns: [], full: true })).toContain('--force');
  });
});

describe('mutationLines flow', () => {
  it('exits 1 without a merge base and never starts Stryker', async () => {
    const { d, out } = deps({ mergeBaseFn: async () => ({ sha: null, tried: ['develop'] }) });
    expect(await mutationLines(d)).toBe(1);
    expect(out.join('\n')).toContain('no merge base');
    expect(d.spawnFn).not.toHaveBeenCalled();
  });

  it('exits 1 when git diff fails', async () => {
    const { d } = deps({ gitFn: async () => null });
    expect(await mutationLines(d)).toBe(1);
    expect(d.spawnFn).not.toHaveBeenCalled();
  });

  it('exits 0 with no mutate-set change, without Stryker and without gh', async () => {
    const { d, out } = deps({ patterns: ['src/other/**'] });
    expect(await mutationLines(d)).toBe(0);
    expect(d.spawnFn).not.toHaveBeenCalled();
    expect(out.join('\n')).toContain('nothing to run');
  });

  it('prints the scope line and passes joined ranges and whole untracked files to Stryker', async () => {
    const { d, out } = deps();
    expect(await mutationLines(d)).toBe(0);
    expect(out[0]).toBe('mutation: 2 files, branch diff since abcdef012345');
    const [cmd, args] = d.spawnFn.mock.calls[0];
    expect(cmd).toBe(process.execPath);
    expect(args[0]).toBe('/nm/stryker.js');
    expect(args).toContain('src/extension/a.ts:10-11,src/extension/a.ts:30-30,src/extension/new.ts');
    expect(args).toContain('/w/.git/karst-gate-state/stryker-lines.json');
    expect(args).toContain('4');
    expect(args).toContain('/w/.git/karst-gate-state/stryker-lines.config.json');
    expect(d.prepare).toHaveBeenCalledWith('/w/.git/karst-gate-state', '/w/.git/karst-gate-state/stryker-lines.config.json');
  });

  it('fails on a surviving mutant and prints the table', async () => {
    const { d, out } = deps({ readReport: () => survived });
    expect(await mutationLines(d)).toBe(1);
    expect(out.join('\n')).toContain('| src/extension/a.ts:10 | BooleanLiteral | `false` | Survived |');
  });

  it('uses one worker under KARST_GATE_MAX_WORKERS=1 and --force under KARST_GATE_FULL=1', async () => {
    const { d } = deps({ env: { KARST_GATE_MAX_WORKERS: '1', KARST_GATE_FULL: '1' } });
    await mutationLines(d);
    const args = d.spawnFn.mock.calls[0][1];
    expect(args[args.indexOf('--concurrency') + 1]).toBe('1');
    expect(args).toContain('--force');
  });

  it('exits 127 when the Stryker bin does not resolve', async () => {
    const { d, out } = deps({ resolveBin: () => null });
    expect(await mutationLines(d)).toBe(127);
    expect(out.join('\n')).toContain('not installed');
    expect(d.spawnFn).not.toHaveBeenCalled();
  });

  it('names the files when no test imports them', async () => {
    const { d, out } = deps({ readReport: () => null, spawnFn: vi.fn(async () => ({ status: 1, out: 'Error: No tests were executed' })) });
    expect(await mutationLines(d)).toBe(1);
    expect(out.join('\n')).toContain('mutation: no test imports src/extension/a.ts, src/extension/new.ts');
    expect(d.driftFn).not.toHaveBeenCalled();
  });

  it('re-judges a failed dry run on the base: drift passes, a break fails', async () => {
    const run = { readReport: () => null, spawnFn: vi.fn(async () => ({ status: 1, out: 'There were failed tests in the initial test run.' })) };
    const drift = deps({ ...run, driftFn: vi.fn(async () => 0) });
    expect(await mutationLines(drift.d)).toBe(0);
    expect(drift.d.driftFn).toHaveBeenCalledWith('/w', ['src/extension/a.ts', 'src/extension/new.ts']);
    const broke = deps({ ...run, driftFn: vi.fn(async () => 1) });
    expect(await mutationLines(broke.d)).toBe(1);
    expect(broke.out.join('\n')).toContain('mutation: the initial test run failed');
  });

  it('names a test runner crash in the dry run, never a bare missing report', async () => {
    const { d, out } = deps({ readReport: () => null, spawnFn: vi.fn(async () => ({ status: 1, out: 'Test runner crashed. exited unexpectedly with exit code null (SIGSEGV)' })) });
    expect(await mutationLines(d)).toBe(1);
    expect(out.join('\n')).toContain('mutation: the test runner crashed in the initial test run (SIGSEGV)');
    expect(d.driftFn).not.toHaveBeenCalled();
  });

  it('fails closed with the reason when there is no report', async () => {
    const { d, out } = deps({ readReport: () => null, spawnFn: vi.fn(async () => ({ status: 3, out: '' })) });
    expect(await mutationLines(d)).toBe(1);
    expect(out.join('\n')).toContain('mutation: no report (stryker exited 3)');
  });

  it('fails closed on a report without files', async () => {
    const { d, out } = deps({ readReport: () => ({}) });
    expect(await mutationLines(d)).toBe(1);
    expect(out.join('\n')).toContain('malformed report');
  });

  it('reads the report even when Stryker exits non-zero', async () => {
    const { d } = deps({ spawnFn: vi.fn(async () => ({ status: 1, out: '' })) });
    expect(await mutationLines(d)).toBe(0);
  });
});
