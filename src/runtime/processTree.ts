import { spawn } from 'node:child_process';

/**
 * What actually happened when `killTree` tried to signal a process group.
 *
 * `process.kill` throwing does not mean "nothing happened" — ESRCH means the
 * target was already gone (the goal was already true) and EPERM means it is
 * very much alive and we were refused (the goal was NOT met). Collapsing both
 * into a swallowed exception is how a caller ends up believing a still-running,
 * permission-denied process was stopped. `denied` is the one outcome a caller
 * must never read as success.
 */
export type KillOutcome =
  /** SIGKILL was delivered, or the target no longer existed. */
  | 'killed'
  /** The target exists but signalling it was refused (EPERM). Still running. */
  | 'denied'
  /** Platform cannot report a synchronous result (Windows: `taskkill` is fired async). */
  | 'unknown';

/**
 * Kill a detached process group, falling back to its leader. On POSIX, a
 * negative pid targets the group and therefore descendants that inherited it.
 * Windows uses non-blocking taskkill /T, with a direct signal as its fallback —
 * both fire-and-forget, so no synchronous outcome is available there.
 */
export function killTree(pid: number): KillOutcome {
  if (process.platform === 'win32') {
    let fellBack = false;
    const killLeader = (): void => {
      if (fellBack) return;
      fellBack = true;
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // Already gone.
      }
    };
    try {
      const killer = spawn('taskkill', ['/pid', String(pid), '/t', '/f'], {
        stdio: 'ignore',
        windowsHide: true,
      });
      killer.once('error', killLeader);
      killer.once('close', (code) => {
        if (code !== 0) killLeader();
      });
      return 'unknown';
    } catch {
      killLeader();
      return 'unknown';
    }
  }
  try {
    process.kill(-pid, 'SIGKILL');
    return 'killed';
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EPERM') return 'denied';
    try {
      process.kill(pid, 'SIGKILL');
      return 'killed';
    } catch (err2) {
      if ((err2 as NodeJS.ErrnoException).code === 'EPERM') return 'denied';
      return 'killed'; // ESRCH or anything else unexpected: nothing left to signal.
    }
  }
}
