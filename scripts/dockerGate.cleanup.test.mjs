import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BASE_DIR_MAX_AGE_MS, bestEffort, judgeAgainstBase, sweepStaleBaseDirs } from './dockerGate.mjs';

const spec = (status) => ({
  specs: [
    {
      title: 'home',
      tests: [{ projectName: 'visual', status, results: [{ attachments: [{ name: 'home-expected.png', path: 'tests/visual/__baselines__/home.png' }] }] }],
    },
  ],
});

describe('bestEffort', () => {
  it('prints one NOTICE line with the error code and returns false', () => {
    const log = vi.fn();
    const ok = bestEffort('/tmp/x', () => {
      throw Object.assign(new Error('denied'), { code: 'EACCES' });
    }, log);
    expect(ok).toBe(false);
    expect(log).toHaveBeenCalledExactlyOnceWith('NOTICE: base check cleanup failed: /tmp/x: EACCES');
  });

  it('returns true and prints nothing when the step passes', () => {
    const log = vi.fn();
    expect(bestEffort('/tmp/x', () => {}, log)).toBe(true);
    expect(log).not.toHaveBeenCalled();
  });
});

describe('judgeAgainstBase cleanup', () => {
  let work;
  let events;
  let seams;
  let results;
  beforeEach(() => {
    vi.stubEnv('KARST_BASE_REF', 'HEAD');
    vi.stubEnv('GITHUB_ACTIONS', 'true');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    work = mkdtempSync(join(tmpdir(), 'karst-gate-test-'));
    results = join(work, 'results.json');
    writeFileSync(results, JSON.stringify({ suites: [spec('unexpected')] }));
    events = [];
    seams = {
      mkdtempSync: (prefix) => mkdtempSync(prefix),
      git: (args) => {
        events.push(`git ${args[1] ?? args[0]}`);
        return { status: 0, stdout: '', stderr: '' };
      },
      removeContainer: async (name) => {
        events.push(`container ${name}`);
      },
      rmSync: (path, options) => {
        events.push(`rm ${path.includes('karst-base-') ? 'base' : 'other'}`);
        rmSync(path, options);
      },
    };
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    rmSync(work, { recursive: true, force: true });
  });

  const run = async (argv) => {
    const at = argv.indexOf('--name');
    expect(argv[at + 1]).toBe('gate-base');
    const dir = argv[argv.indexOf('-v') + 1].split(':')[0];
    mkdirSync(join(dir, 'tests', 'visual'), { recursive: true });
    writeFileSync(join(dir, 'tests', 'visual', '.results.json'), JSON.stringify({ suites: [spec('expected')] }));
    return 1;
  };
  const input = () => ({ status: 1, rawArgv: ['run', '-v', '{repo}:/work', 'x/playwright:1'], name: 'gate', volume: null, run, results, seams });

  it('keeps the base-check verdict when removing the base worktree throws EACCES', async () => {
    seams.rmSync = (path) => {
      if (path.includes('karst-base-')) throw Object.assign(new Error('denied'), { code: 'EACCES' });
    };
    const status = await judgeAgainstBase(input());
    expect(status).toBe(1);
    const lines = console.error.mock.calls.map((c) => c[0]);
    expect(lines.filter((l) => l.startsWith('NOTICE: base check cleanup failed: ') && l.endsWith(': EACCES'))).toHaveLength(1);
  });

  it('removes the base container before the base worktree', async () => {
    await judgeAgainstBase(input());
    const container = events.indexOf('container gate-base');
    expect(container).toBeGreaterThanOrEqual(0);
    expect(container).toBeLessThan(events.indexOf('git remove'));
    expect(container).toBeLessThan(events.indexOf('rm base'));
  });
});

describe('sweepStaleBaseDirs', () => {
  it('sweeps karst-base dirs older than one day', () => {
    const dir = mkdtempSync(join(tmpdir(), 'karst-sweep-test-'));
    const now = Date.now();
    const make = (name, ageMs) => {
      const path = join(dir, name);
      mkdirSync(path);
      const t = (now - ageMs) / 1000;
      utimesSync(path, t, t);
      return path;
    };
    const old = make('karst-base-old', BASE_DIR_MAX_AGE_MS + 60_000);
    const fresh = make('karst-base-new', 60_000);
    const other = make('unrelated-old', BASE_DIR_MAX_AGE_MS * 3);
    const git = vi.fn(() => ({ status: 0 }));
    sweepStaleBaseDirs({ dir, now, seams: { git }, log: () => {} });
    expect(existsSync(old)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(other)).toBe(true);
    expect(git).toHaveBeenCalledWith(['worktree', 'prune'], expect.anything());
    rmSync(dir, { recursive: true, force: true });
  });

  it('never throws when the temp dir is unreadable', () => {
    const log = vi.fn();
    expect(() => sweepStaleBaseDirs({ dir: '/nonexistent-karst-dir', log })).not.toThrow();
    expect(log).toHaveBeenCalledOnce();
  });
});
