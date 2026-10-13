import { describe, expect, it } from 'vitest';
import {
  checkInotifyWatches,
  type InotifyProbes,
  INOTIFY_CHECK_ID,
} from './inotifyWatchCheck.js';

function baseProbes(overrides: Partial<InotifyProbes> = {}): InotifyProbes {
  return {
    platform: 'linux',
    maxUserWatches: () => 100000,
    countInotifyWatches: () => 1000,
    ...overrides,
  };
}

describe('checkInotifyWatches', () => {
  it('is skipped on non-linux platforms', () => {
    const checksDarwin = checkInotifyWatches(baseProbes({ platform: 'darwin' }));
    expect(checksDarwin).toEqual([]);

    const checksWin32 = checkInotifyWatches(baseProbes({ platform: 'win32' }));
    expect(checksWin32).toEqual([]);
  });

  it('reports user-wide holders, not a single process', () => {
    const [check] = checkInotifyWatches(baseProbes());
    expect(check!.detail).toContain('Your processes hold');
    expect(check!.detail).not.toContain('Extension host');
  });

  it('passes (status ok) when watch count is well below 80% of limit', () => {
    const checks = checkInotifyWatches(
      baseProbes({
        maxUserWatches: () => 100000,
        countInotifyWatches: () => 1000,
      }),
    );
    expect(checks).toHaveLength(1);
    const check = checks[0]!;
    expect(check.id).toBe(INOTIFY_CHECK_ID);
    expect(check.area).toBe('tools');
    expect(check.status).toBe('ok');
    expect(check.detail).toContain('1,000');
    expect(check.detail).toContain('100,000');
    expect(check.fix).toBeUndefined();
  });

  it('warns when watch count is at or above 80% but below 95% of limit', () => {
    const checks80 = checkInotifyWatches(
      baseProbes({
        maxUserWatches: () => 100000,
        countInotifyWatches: () => 80000,
      }),
    );
    expect(checks80).toHaveLength(1);
    const check80 = checks80[0]!;
    expect(check80.id).toBe(INOTIFY_CHECK_ID);
    expect(check80.area).toBe('tools');
    expect(check80.status).toBe('warn');
    expect(check80.detail).toContain('80,000');
    expect(check80.detail).toContain('100,000');
    expect(check80.detail).toContain('recursive watchers on worktrees with node_modules');
    expect(check80.fix).toBeDefined();
    expect(check80.fix?.tier).toBe('report');
    expect(check80.fix?.summary).toContain('inotify watch limit');
    const fix80 = check80.fix?.tier === 'report' ? check80.fix : undefined;
    expect(fix80?.nextStep).toContain('sysctl');
    expect(fix80?.nextStep).toContain('/etc/sysctl.d');

    const checks94 = checkInotifyWatches(
      baseProbes({
        maxUserWatches: () => 100000,
        countInotifyWatches: () => 94999,
      }),
    );
    expect(checks94[0]!.status).toBe('warn');
  });

  it('fails when watch count is at or above 95% of limit', () => {
    const checks95 = checkInotifyWatches(
      baseProbes({
        maxUserWatches: () => 100000,
        countInotifyWatches: () => 95000,
      }),
    );
    expect(checks95).toHaveLength(1);
    const check95 = checks95[0]!;
    expect(check95.id).toBe(INOTIFY_CHECK_ID);
    expect(check95.area).toBe('tools');
    expect(check95.status).toBe('fail');
    expect(check95.detail).toContain('95,000');
    expect(check95.detail).toContain('100,000');
    expect(check95.detail).toContain('recursive watchers on worktrees with node_modules');
    expect(check95.fix).toBeDefined();
    expect(check95.fix?.tier).toBe('report');
    const fix95 = check95.fix?.tier === 'report' ? check95.fix : undefined;
    expect(fix95?.nextStep).toContain('sysctl');
    expect(fix95?.nextStep).toContain('/etc/sysctl.d');

    const checks100 = checkInotifyWatches(
      baseProbes({
        maxUserWatches: () => 100000,
        countInotifyWatches: () => 105000,
      }),
    );
    expect(checks100[0]!.status).toBe('fail');
  });

  it('warns when max_user_watches cannot be read', () => {
    const checks = checkInotifyWatches(
      baseProbes({
        maxUserWatches: () => undefined,
        countInotifyWatches: () => 500,
      }),
    );
    expect(checks).toHaveLength(1);
    const check = checks[0]!;
    expect(check.id).toBe(INOTIFY_CHECK_ID);
    expect(check.status).toBe('warn');
    expect(check.detail).toContain('/proc/sys/fs/inotify/max_user_watches');
  });

  it('warns when inotify watch count cannot be read', () => {
    const checks = checkInotifyWatches(
      baseProbes({
        maxUserWatches: () => 100000,
        countInotifyWatches: () => undefined,
      }),
    );
    expect(checks).toHaveLength(1);
    const check = checks[0]!;
    expect(check.id).toBe(INOTIFY_CHECK_ID);
    expect(check.status).toBe('warn');
    expect(check.detail).toContain('/proc/<pid>/fdinfo');
  });
});
