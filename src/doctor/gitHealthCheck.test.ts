import { describe, expect, it } from 'vitest';
import { checkGitHealth, type GitRepoHealth } from './gitHealthCheck.js';

const NOW = 1_800_000_000_000;
const H = 3_600_000;
const repo = (over: Partial<GitRepoHealth>): GitRepoHealth => ({ name: 'app', repoPath: '/r/app', commonDir: '/r/app/.git', packCount: 3, autoPackLimit: 50, ...over });
const ALL = repo({ maintenanceLockMtimeMs: NOW - 7 * H, gcPidMtimeMs: NOW - 7 * H, packCount: 51 });

describe('checkGitHealth', () => {
  it('healthy repo gives no checks', () => {
    expect(checkGitHealth([repo({})], NOW)).toEqual([]);
  });

  it('a lock older than 6 h warns with the exact command', () => {
    const got = checkGitHealth([repo({ maintenanceLockMtimeMs: NOW - 7 * H })], NOW);
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ id: 'state.git-maintenance-lock.app', status: 'warn' });
    expect(got[0]!.detail).toContain('7 h old');
    expect(got[0]!.fix).toEqual({ tier: 'consented', summary: 'stale git maintenance lock', command: 'rm "/r/app/.git/objects/maintenance.lock" && git -C "/r/app" gc' });
  });

  it('a lock exactly 6 h old gives no check', () => {
    expect(checkGitHealth([repo({ maintenanceLockMtimeMs: NOW - 6 * H })], NOW)).toEqual([]);
  });

  it('a fresh lock gives no check', () => {
    expect(checkGitHealth([repo({ maintenanceLockMtimeMs: NOW - 60_000 })], NOW)).toEqual([]);
  });

  it('a stale gc.pid warns', () => {
    const got = checkGitHealth([repo({ gcPidMtimeMs: NOW - 8 * H })], NOW);
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ id: 'state.git-gc-pid.app', status: 'warn' });
    expect(got[0]!.fix).toMatchObject({ command: 'rm "/r/app/.git/gc.pid" && git -C "/r/app" gc' });
  });

  it('a pack count above the limit warns', () => {
    const got = checkGitHealth([repo({ packCount: 51 })], NOW);
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ id: 'state.git-pack-count.app', status: 'warn' });
    expect(got[0]!.detail).toContain('51 packs');
    expect(got[0]!.fix).toMatchObject({ command: 'git -C "/r/app" gc' });
  });

  it('a pack count equal to the limit gives no check', () => {
    expect(checkGitHealth([repo({ packCount: 50 })], NOW)).toEqual([]);
  });

  it('limit 0 disables the pack check', () => {
    expect(checkGitHealth([repo({ packCount: 500, autoPackLimit: 0 })], NOW)).toEqual([]);
  });

  it('orders lock, gc-pid, pack-count for one repo', () => {
    expect(checkGitHealth([ALL], NOW).map((c) => c.id)).toEqual(['state.git-maintenance-lock.app', 'state.git-gc-pid.app', 'state.git-pack-count.app']);
  });

  it('every fix is consented, never auto', () => {
    expect(checkGitHealth([ALL], NOW).map((c) => c.fix?.tier)).toEqual(['consented', 'consented', 'consented']);
  });
});
