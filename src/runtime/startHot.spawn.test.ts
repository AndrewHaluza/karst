import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openStore, type Store } from '../store/db.js';
import type { ShimEnv } from './command.js';

const spawnMock = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ spawn: spawnMock, spawnSync: vi.fn() }));

// A start that never spawns a real child: taskkill/process.kill must not run.
vi.mock('./processTree.js', () => ({ killTree: vi.fn(() => 'killed' as const) }));

// Force the spawn-and-race path without waiting out a real health deadline.
vi.mock('./health.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./health.js')>();
  return { ...actual, waitForHealth: vi.fn(async () => { throw new Error('health timeout'); }) };
});

import { startHot } from './supervisor.js';

/** A Windows lookup env where a bare `npm` resolves to a `npm.cmd` batch shim. */
const windowsShimEnv: ShimEnv = {
  platform: 'win32',
  pathVar: 'C:\\tools',
  pathExt: '.COM;.EXE;.BAT;.CMD',
  exists: (path) => path.endsWith('npm.cmd'),
};

/** A fake child that yields a pid and then settles via the failing health race. */
function fakeChild(): EventEmitter & { pid: number } {
  const child = new EventEmitter() as EventEmitter & { pid: number };
  child.pid = 4242;
  return child;
}

describe('startHot service spawn translation (P2-08)', () => {
  let store: Store;
  let dir: string;

  const opts = (shimEnv: ShimEnv) => ({
    ticketId: 1,
    service: 'web',
    command: 'npm',
    args: ['run', 'dev'],
    cwd: '/tmp/fake-worktree',
    env: { PORT: '5173' },
    host: '127.0.0.1',
    port: 1,
    healthUrl: 'http://127.0.0.1:1/health',
    logPath: join(dir, 'web.log'),
    repoPath: '/tmp/fake-repo',
    shimEnv,
  });

  beforeEach(() => {
    store = openStore(':memory:');
    dir = mkdtempSync(join(tmpdir(), 'karst-spawn-'));
    spawnMock.mockReset();
    spawnMock.mockImplementation(() => fakeChild());
  });

  afterEach(() => {
    vi.restoreAllMocks();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('routes a service command through prepareCommand, spawning cmd.exe for a Windows shim', async () => {
    await expect(startHot(store, opts(windowsShimEnv))).rejects.toThrow();

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [command, args, spawnOpts] = spawnMock.mock.calls[0]!;
    expect(command).toBe('cmd.exe');
    expect(args.slice(0, 3)).toEqual(['/d', '/s', '/c']);
    expect(args[3]).toContain('npm');
    expect(args[3]).toContain('run');
    expect(spawnOpts).toMatchObject({ detached: true, windowsVerbatimArguments: true });
  });

  it('leaves a POSIX command untouched (no shim wrapper)', async () => {
    await expect(startHot(store, opts({ ...windowsShimEnv, platform: 'darwin' }))).rejects.toThrow();

    const [command, args, spawnOpts] = spawnMock.mock.calls[0]!;
    expect(command).toBe('npm');
    expect(args).toEqual(['run', 'dev']);
    expect(spawnOpts.windowsVerbatimArguments).toBeUndefined();
  });
});
