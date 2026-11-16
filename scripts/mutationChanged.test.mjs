import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CHANGED_LIST, DEVELOP_DIR, REPORT, addedSince, downloadDevelopReport, globToRegExp, inMutateSet, judge,
  mutationChanged, scopeMessage, selectMutateFiles, strykerArgs,
} from './mutationChanged.mjs';

const PATTERNS = ['src/extension/**/*.ts', '!src/extension/**/*.test.ts', '!src/extension/secrets.ts'];
const dirs = [];
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'mutation-changed-'));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('mutate-set filter', () => {
  it('matches ** across directories and * inside one segment', () => {
    expect(globToRegExp('src/**/*.ts').test('src/a.ts')).toBe(true);
    expect(globToRegExp('src/**/*.ts').test('src/a/b/c.ts')).toBe(true);
    expect(globToRegExp('src/*.ts').test('src/a/b.ts')).toBe(false);
    expect(globToRegExp('a.ts').test('aXts')).toBe(false);
    expect(globToRegExp('a?.ts').test('ab.ts')).toBe(true);
    expect(globToRegExp('a?.ts').test('a/.ts')).toBe(false);
    expect(globToRegExp('src/**').test('src/a/b')).toBe(true);
  });

  it('applies the negations', () => {
    expect(inMutateSet('src/extension/ops/x.ts', PATTERNS)).toBe(true);
    expect(inMutateSet('src/extension/ops/x.test.ts', PATTERNS)).toBe(false);
    expect(inMutateSet('src/extension/secrets.ts', PATTERNS)).toBe(false);
    expect(inMutateSet('src/other/x.ts', PATTERNS)).toBe(false);
  });

  it('keeps sorted unique existing mutate-set files', () => {
    const changed = ['src/extension/b.ts', 'src/extension/a.ts', 'src/extension/a.ts', 'src/extension/gone.ts', 'docs/x.md', 'src/extension/c.test.ts'];
    expect(selectMutateFiles(changed, PATTERNS, (p) => p !== 'src/extension/gone.ts')).toEqual(['src/extension/a.ts', 'src/extension/b.ts']);
  });

  it('builds the stryker args and the scope line', () => {
    expect(strykerArgs(['a.ts', 'b.ts'])).toEqual(['stryker', 'run', '--mutate', 'a.ts,b.ts', '--incremental', '--incrementalFile', 'reports/stryker-incremental.json']);
    expect(scopeMessage([], 'abc')).toContain('nothing to run');
    expect(scopeMessage(['a'], 'abcdef0123456789')).toBe('mutation:changed: 1 changed mutate-set files since abcdef012345');
  });
});

describe('addedSince', () => {
  it('joins added and untracked, and returns null when git fails', async () => {
    const gitFn = async (_cwd, args) => (args[0] === 'diff' ? 'a.ts\0' : 'b.ts\0');
    expect(await addedSince('.', 'sha', gitFn)).toEqual(['a.ts', 'b.ts']);
    expect(await addedSince('.', 'sha', async () => null)).toBeNull();
  });
});

describe('downloadDevelopReport', () => {
  it('returns null when gh list fails', async () => {
    const exec = vi.fn(async () => ({ status: 1, stdout: '' }));
    expect(await downloadDevelopReport(tempDir(), { exec })).toBeNull();
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it('returns null when no run has the artifact', async () => {
    const exec = vi.fn(async (_c, args) => (args[1] === 'list' ? { status: 0, stdout: '3\n2\n' } : { status: 1, stdout: '' }));
    expect(await downloadDevelopReport(tempDir(), { exec })).toBeNull();
    expect(exec).toHaveBeenCalledTimes(3);
  });

  it('takes the newest run whose download yields mutation.json, and limits the tries', async () => {
    const cwd = tempDir();
    const exec = vi.fn(async (_c, args) => {
      if (args[1] === 'list') return { status: 0, stdout: '9\n8\n7\n' };
      if (args[2] === '8') {
        mkdirSync(join(cwd, DEVELOP_DIR), { recursive: true });
        writeFileSync(join(cwd, DEVELOP_DIR, 'mutation.json'), '{}');
      }
      return { status: args[2] === '9' ? 1 : 0, stdout: '' };
    });
    expect(await downloadDevelopReport(cwd, { exec })).toBe(join(cwd, DEVELOP_DIR, 'mutation.json'));
    const limited = vi.fn(async (_c, args) => (args[1] === 'list' ? { status: 0, stdout: '3\n2\n1\n' } : { status: 1, stdout: '' }));
    await downloadDevelopReport(tempDir(), { exec: limited, tries: 2 });
    expect(limited).toHaveBeenCalledTimes(3);
  });
});

/** A Stryker report with one file per entry: [path, [statuses]]. */
function report(entries) {
  const files = {};
  for (const [path, statuses] of entries) {
    files[path] = {
      language: 'typescript', source: 'x',
      mutants: statuses.map((status, i) => ({ id: String(i), mutatorName: 'm', replacement: 'r', status, location: { start: { line: 1, column: 1 }, end: { line: 1, column: 2 } } })),
    };
  }
  return JSON.stringify({ schemaVersion: '1.0', thresholds: { high: 85, low: 75, break: 85 }, files });
}

function workdir(entries) {
  const cwd = tempDir();
  mkdirSync(join(cwd, 'reports/mutation'), { recursive: true });
  writeFileSync(join(cwd, REPORT), report(entries));
  writeFileSync(join(cwd, 'stryker.config.json'), JSON.stringify({ thresholds: { break: 85 } }));
  return cwd;
}

describe('judge', () => {
  const LOW = ['Killed', 'Survived'];
  const HIGH = Array(9).fill('Killed').concat('Survived');

  it('fails a new file below the break when no develop report exists', () => {
    const cwd = workdir([['src/extension/n.ts', LOW]]);
    const out = judge({ files: ['src/extension/n.ts'], added: ['src/extension/n.ts'], developReport: null, cwd });
    expect(out.exitCode).toBe(1);
    expect(readFileSync(join(cwd, CHANGED_LIST), 'utf8')).toBe('src/extension/n.ts\n');
  });

  it('warns but passes a modified file below the break when no develop report exists', () => {
    const cwd = workdir([['src/extension/m.ts', LOW]]);
    const out = judge({ files: ['src/extension/m.ts'], added: [], developReport: null, cwd });
    expect(out.exitCode).toBe(0);
    expect(out.warnings).toHaveLength(1);
    expect(out.warnings[0]).toContain('src/extension/m.ts scores 50.00, 1 undetected');
  });

  it('judges only the new file and warns for the modified one', () => {
    const cwd = workdir([['src/extension/n.ts', HIGH], ['src/extension/m.ts', LOW]]);
    const out = judge({ files: ['src/extension/m.ts', 'src/extension/n.ts'], added: ['src/extension/n.ts'], developReport: null, cwd });
    expect(out.exitCode).toBe(0);
    expect(out.warnings).toHaveLength(1);
    expect(readFileSync(join(cwd, CHANGED_LIST), 'utf8')).toBe('src/extension/n.ts\n');
  });

  it('warns that the report is unusable for a modified file', () => {
    const cwd = workdir([]);
    rmSync(join(cwd, REPORT));
    const out = judge({ files: ['src/extension/m.ts'], added: [], developReport: null, cwd });
    expect(out.exitCode).toBe(0);
    expect(out.warnings[0]).toContain('PR report');
  });

  it('gives every changed file to the gate when a develop report exists', () => {
    const cwd = workdir([['src/extension/m.ts', LOW]]);
    const dev = join(cwd, 'dev.json');
    writeFileSync(dev, report([['src/extension/m.ts', ['Killed', 'Killed']]]));
    const out = judge({ files: ['src/extension/m.ts'], added: [], developReport: dev, cwd });
    expect(out.exitCode).toBe(1);
    expect(out.warnings).toEqual([]);
  });

  it('fails closed with a missing PR report when a new file needs the gate', () => {
    const cwd = workdir([]);
    rmSync(join(cwd, REPORT));
    expect(judge({ files: ['src/extension/n.ts'], added: ['src/extension/n.ts'], developReport: null, cwd }).exitCode).toBe(1);
  });
});

describe('mutationChanged', () => {
  const base = (over = {}) => ({
    cwd: tempDir(),
    mergeBaseFn: async () => ({ sha: 'abcdef0123456789', tried: [] }),
    changedFn: async () => ['src/extension/a.ts', 'README.md'],
    addedFn: async () => [],
    runToolFn: vi.fn(async () => 0),
    downloadFn: vi.fn(async () => null),
    judgeFn: vi.fn(() => ({ exitCode: 0, markdown: 'md', annotations: [], warnings: [] })),
    exists: () => true,
    patterns: PATTERNS,
    log: vi.fn(),
    ...over,
  });

  it('exits 0 with one line and runs nothing when no file is in the mutate set', async () => {
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const deps = base({ changedFn: async () => ['README.md', 'src/extension/a.test.ts'] });
    expect(await mutationChanged(deps)).toBe(0);
    expect(deps.log).toHaveBeenCalledTimes(1);
    expect(deps.log.mock.calls[0][0]).toContain('nothing to run');
    expect(deps.runToolFn).not.toHaveBeenCalled();
    expect(deps.downloadFn).not.toHaveBeenCalled();
  });

  it('runs stryker on the selected files and returns the gate exit code', async () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const deps = base({ judgeFn: vi.fn(() => ({ exitCode: 1, markdown: 'md', annotations: ['::a'], warnings: ['w'] })) });
    expect(await mutationChanged(deps)).toBe(1);
    expect(deps.runToolFn).toHaveBeenCalledWith('npx', strykerArgs(['src/extension/a.ts']), deps.cwd);
    expect(deps.judgeFn).toHaveBeenCalledWith({ files: ['src/extension/a.ts'], added: [], developReport: null, cwd: deps.cwd });
    expect(write).toHaveBeenCalledWith('md\n');
    expect(deps.log).toHaveBeenCalledWith('::a');
    expect(deps.log).toHaveBeenCalledWith('w');
    expect(deps.log).toHaveBeenCalledWith(expect.stringContaining('no develop report'));
  });

  it('does not fail on a stryker break status and passes the develop report on', async () => {
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const deps = base({ runToolFn: vi.fn(async () => 1), downloadFn: vi.fn(async () => '/d.json') });
    expect(await mutationChanged(deps)).toBe(0);
    expect(deps.judgeFn).toHaveBeenCalledWith(expect.objectContaining({ developReport: '/d.json' }));
    expect(deps.log).toHaveBeenCalledWith(expect.stringContaining('stryker exited 1'));
  });

  it('fails when there is no merge base or git diff fails', async () => {
    expect(await mutationChanged(base({ mergeBaseFn: async () => ({ sha: null, tried: ['x'] }) }))).toBe(1);
    expect(await mutationChanged(base({ changedFn: async () => null }))).toBe(1);
    expect(await mutationChanged(base({ addedFn: async () => null }))).toBe(1);
  });
});
