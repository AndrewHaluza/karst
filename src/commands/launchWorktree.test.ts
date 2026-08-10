import { describe, it, expect, vi } from 'vitest';
import type { ProjectWorktreeRow } from '../store/dashboard.js';
import {
  isKarstCheckout,
  selectLaunchableWorktrees,
  resolveCliPath,
  resolveLaunchCli,
  launchWorktreeDev,
  type LaunchWorktreeEffects,
} from './launchWorktree.js';
import { DEFAULT_LAUNCH_CONFIG } from './launchWorktreeConfig.js';

const rows: ProjectWorktreeRow[] = [
  { ticketId: 1, key: 'K-1', repo: 'Karst-extention', path: '/wt/karst-1', branch: 'feat/a' },
  { ticketId: 2, key: 'K-2', repo: 'App', path: '/wt/app-2', branch: null },
];

describe('isKarstCheckout', () => {
  it('accepts a package.json whose name is karst', () => {
    const readFile = vi.fn(() => JSON.stringify({ name: 'karst', version: '1.0.0' }));
    expect(isKarstCheckout('/wt/x', readFile)).toBe(true);
    expect(readFile).toHaveBeenCalledWith('/wt/x/package.json');
  });

  it('rejects another package name', () => {
    expect(isKarstCheckout('/wt/x', () => JSON.stringify({ name: 'my-app' }))).toBe(false);
  });

  it('rejects a missing or unreadable package.json', () => {
    expect(isKarstCheckout('/wt/x', () => { throw new Error('ENOENT'); })).toBe(false);
  });

  it('rejects malformed JSON and non-object payloads', () => {
    expect(isKarstCheckout('/wt/x', () => 'not json')).toBe(false);
    expect(isKarstCheckout('/wt/x', () => '"karst"')).toBe(false);
  });
});

describe('selectLaunchableWorktrees', () => {
  it('keeps only rows whose path is a karst checkout', () => {
    const probe = (p: string) => p.includes('karst');
    const picked = selectLaunchableWorktrees(rows, probe);
    expect(picked).toEqual([rows[0]]);
  });

  it('returns nothing when no checkout matches', () => {
    expect(selectLaunchableWorktrees(rows, () => false)).toEqual([]);
  });
});

describe('resolveCliPath', () => {
  it('resolves the in-bundle CLI on darwin', () => {
    expect(resolveCliPath('/App/Contents/Resources/app', 'darwin')).toBe(
      '/App/Contents/Resources/app/bin/code',
    );
  });

  it('resolves the in-bundle CLI on linux (bin is a sibling of resources)', () => {
    expect(resolveCliPath('/opt/vscode/resources/app', 'linux')).toBe(
      '/opt/vscode/bin/code',
    );
  });

  it('resolves code.cmd on win32', () => {
    expect(resolveCliPath('C:\\VS Code\\resources\\app', 'win32')).toBe(
      'C:\\VS Code\\bin\\code.cmd',
    );
  });
});

describe('resolveLaunchCli', () => {
  const effects = (over: Partial<Pick<LaunchWorktreeEffects, 'cliExists' | 'binaryOnPath'>> = {}) => ({
    cliExists: () => true,
    binaryOnPath: () => true,
    ...over,
  });

  it('prefers an explicit idePath over everything else', () => {
    const res = resolveLaunchCli(
      { ...DEFAULT_LAUNCH_CONFIG, idePath: '/opt/my-ide/bin/editor' },
      '/app-root',
      'darwin',
      effects({ binaryOnPath: () => false }),
    );
    expect(res).toEqual({ kind: 'resolved', cliPath: '/opt/my-ide/bin/editor' });
  });

  it('refuses a configured idePath that does not exist', () => {
    const res = resolveLaunchCli(
      { ...DEFAULT_LAUNCH_CONFIG, idePath: '/gone/bin/editor' },
      '/app-root',
      'darwin',
      effects({ cliExists: (p) => p !== '/gone/bin/editor' }),
    );
    expect(res.kind).toBe('unresolved');
  });

  it('uses the running editor bundle CLI under auto', () => {
    const res = resolveLaunchCli(DEFAULT_LAUNCH_CONFIG, '/App/Contents/Resources/app', 'darwin', effects());
    expect(res).toEqual({ kind: 'resolved', cliPath: '/App/Contents/Resources/app/bin/code' });
  });

  it('resolves a named IDE to its PATH binary', () => {
    const res = resolveLaunchCli(
      { ...DEFAULT_LAUNCH_CONFIG, ide: 'cursor' },
      '/app-root',
      'darwin',
      effects(),
    );
    expect(res).toEqual({ kind: 'resolved', cliPath: 'cursor' });
  });

  it('refuses a named IDE whose CLI is not on PATH — never substitutes another', () => {
    const res = resolveLaunchCli(
      { ...DEFAULT_LAUNCH_CONFIG, ide: 'antigravity' },
      '/app-root',
      'darwin',
      effects({ binaryOnPath: () => false }),
    );
    expect(res.kind).toBe('unresolved');
  });
});

describe('launchWorktreeDev', () => {
  const effects = (over: Partial<LaunchWorktreeEffects> = {}): LaunchWorktreeEffects => ({
    cliExists: () => true,
    binaryOnPath: () => true,
    build: async () => ({ kind: 'completed' as const, exitCode: 0, output: '' }),
    spawnWindow: vi.fn(),
    ...over,
  });

  it('launches the dev window with the worktree as folder and development path', async () => {
    const spawnWindow = vi.fn();
    const out = await launchWorktreeDev(
      '/wt/karst-1',
      DEFAULT_LAUNCH_CONFIG,
      '/App/Contents/Resources/app',
      'darwin',
      effects({ spawnWindow }),
    );
    expect(out).toEqual({
      kind: 'launched',
      cliPath: '/App/Contents/Resources/app/bin/code',
      args: ['--extensionDevelopmentPath=/wt/karst-1', '/wt/karst-1'],
    });
    expect(spawnWindow).toHaveBeenCalledWith(
      '/App/Contents/Resources/app/bin/code',
      ['--extensionDevelopmentPath=/wt/karst-1', '/wt/karst-1'],
      '/wt/karst-1',
    );
  });

  it('refuses BEFORE building when the editor CLI is missing', async () => {
    const build = vi.fn(async () => ({ kind: 'completed' as const, exitCode: 0, output: '' }));
    const out = await launchWorktreeDev('/wt/karst-1', DEFAULT_LAUNCH_CONFIG, '/app-root', 'darwin', effects({
      cliExists: () => false,
      build,
    }));
    expect(out.kind).toBe('failed');
    expect(build).not.toHaveBeenCalled();
  });

  it('reports a failed build with capped output', async () => {
    const long = `\n\n${'x'.repeat(600)}`;
    const out = await launchWorktreeDev('/wt/karst-1', DEFAULT_LAUNCH_CONFIG, '/app-root', 'darwin', effects({
      build: async () => ({ kind: 'completed', exitCode: 1, output: `boom${long}` }),
    }));
    expect(out.kind).toBe('failed');
    if (out.kind === 'failed') expect(out.message.length).toBeLessThan(300);
  });

  it('maps an aborted build to an aborted outcome', async () => {
    const out = await launchWorktreeDev('/wt/karst-1', DEFAULT_LAUNCH_CONFIG, '/app-root', 'darwin', effects({
      build: async () => ({ kind: 'aborted' }),
    }));
    expect(out).toEqual({ kind: 'aborted' });
  });

  it('never spawns a window after a failed build', async () => {
    const spawnWindow = vi.fn();
    await launchWorktreeDev('/wt/karst-1', DEFAULT_LAUNCH_CONFIG, '/app-root', 'darwin', effects({
      build: async () => ({ kind: 'failed', message: 'npm broke', output: 'npm broke' }),
      spawnWindow,
    }));
    expect(spawnWindow).not.toHaveBeenCalled();
  });
});
