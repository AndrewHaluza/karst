import { spawnSync } from 'node:child_process';

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
  /**
   * The platform could not report a synchronous result. Retained for callers
   * that must not read it as success, but no longer produced: Windows resolves
   * `taskkill` synchronously (below) so its answer is real.
   */
  | 'unknown';

/** Bound on the synchronous Windows `taskkill` — a wedged call must not freeze the host. */
const TASKKILL_TIMEOUT_MS = 5_000;

/**
 * Classify one direct signal to a single pid. EPERM means the target is alive
 * and we were refused; every other failure (ESRCH, anything unexpected) means
 * there is nothing left to signal.
 */
function directKill(pid: number): KillOutcome {
  try {
    process.kill(pid, 'SIGKILL');
    return 'killed';
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM' ? 'denied' : 'killed';
  }
}

/**
 * Windows has no process GROUP to signal, so `taskkill /t /f` is the only call
 * that reaps a launcher's descendants (e.g. `npm run dev` → Vite) — and it must
 * run SYNCHRONOUSLY here. The previous fire-and-forget `spawn` returned
 * `'unknown'` before taskkill had even started, so every caller that mapped
 * "not denied" to "killed" cleared its row and reported a stop while the
 * process was still running. `spawnSync` makes the exit status knowable, and the
 * direct-signal fallback keeps the answer real even when taskkill is missing or
 * refuses.
 */
function windowsKill(pid: number): KillOutcome {
  let status: number | null = null;
  let failed = false;
  try {
    const r = spawnSync('taskkill', ['/pid', String(pid), '/t', '/f'], {
      stdio: 'ignore',
      windowsHide: true,
      timeout: TASKKILL_TIMEOUT_MS,
    });
    status = r.status;
    failed = r.error !== undefined;
  } catch {
    failed = true;
  }
  // Exit 0 is taskkill's own confirmation that the tree is gone.
  if (!failed && status === 0) return 'killed';
  // Refused, not found, or could not run: ask the OS about the leader directly
  // so the outcome is a real one, never a hopeful `'unknown'`.
  return directKill(pid);
}

/**
 * Kill a detached process group, falling back to its leader. On POSIX, a
 * negative pid targets the group and therefore descendants that inherited it.
 * Windows uses a synchronous `taskkill /T` (which reaps the tree) with a direct
 * leader signal as its fallback.
 */
export function killTree(pid: number): KillOutcome {
  if (process.platform === 'win32') return windowsKill(pid);

  try {
    process.kill(-pid, 'SIGKILL');
    return 'killed';
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EPERM') return 'denied';
    return directKill(pid);
  }
}
