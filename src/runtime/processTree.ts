import { spawn } from 'node:child_process';

/**
 * Kill a detached process group, falling back to its leader. On POSIX, a
 * negative pid targets the group and therefore descendants that inherited it.
 * Windows uses non-blocking taskkill /T, with a direct signal as its fallback.
 */
export function killTree(pid: number): void {
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
      return;
    } catch {
      killLeader();
      return;
    }
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Already gone.
    }
  }
}
