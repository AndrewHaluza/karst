import type { DoctorCheck } from './types.js';

/**
 * Git health for `karst doctor` (state area). Report-only: it never deletes a lock and never runs `git gc`.
 * `objects/maintenance.lock` carries no PID, so its age is the only signal; the fix is a consented command.
 */

/** Older than this, a git maintenance lock or gc.pid is left over from a stopped run (a real run never takes this long). */
export const STALE_GIT_LOCK_MS = 6 * 60 * 60 * 1000;
/** git's default `gc.autoPackLimit`. */
export const DEFAULT_AUTO_PACK_LIMIT = 50;

const MS_PER_HOUR = 3_600_000;

export interface GitRepoHealth {
  /** Manifest repository name. */
  readonly name: string;
  readonly repoPath: string;
  /** Absolute git common dir (the main `.git` for a worktree). */
  readonly commonDir: string;
  /** mtime of `<commonDir>/objects/maintenance.lock`, absent when the file does not exist. */
  readonly maintenanceLockMtimeMs?: number;
  /** mtime of `<commonDir>/gc.pid`, absent when the file does not exist. */
  readonly gcPidMtimeMs?: number;
  readonly packCount: number;
  /** `gc.autoPackLimit`; 0 disables the pack-count check. */
  readonly autoPackLimit: number;
}

const hoursOld = (nowMs: number, mtimeMs: number): number => Math.floor((nowMs - mtimeMs) / MS_PER_HOUR);
const isStale = (nowMs: number, mtimeMs: number | undefined): mtimeMs is number => mtimeMs !== undefined && nowMs - mtimeMs > STALE_GIT_LOCK_MS;

export function checkGitHealth(repos: readonly GitRepoHealth[], nowMs: number): DoctorCheck[] {
  const out: DoctorCheck[] = [];
  for (const r of repos) {
    if (isStale(nowMs, r.maintenanceLockMtimeMs)) {
      out.push({
        id: `state.git-maintenance-lock.${r.name}`, area: 'state', status: 'warn',
        detail: `repo ${r.name}: ${r.commonDir}/objects/maintenance.lock is ${hoursOld(nowMs, r.maintenanceLockMtimeMs)} h old; git maintenance and automatic gc cannot run while it exists`,
        fix: { tier: 'consented', summary: 'stale git maintenance lock', command: `rm "${r.commonDir}/objects/maintenance.lock" && git -C "${r.repoPath}" gc` },
      });
    }
    if (isStale(nowMs, r.gcPidMtimeMs)) {
      out.push({
        id: `state.git-gc-pid.${r.name}`, area: 'state', status: 'warn',
        detail: `repo ${r.name}: ${r.commonDir}/gc.pid is ${hoursOld(nowMs, r.gcPidMtimeMs)} h old; automatic gc may be blocked`,
        fix: { tier: 'consented', summary: 'stale git gc.pid', command: `rm "${r.commonDir}/gc.pid" && git -C "${r.repoPath}" gc` },
      });
    }
    if (r.autoPackLimit > 0 && r.packCount > r.autoPackLimit) {
      out.push({
        id: `state.git-pack-count.${r.name}`, area: 'state', status: 'warn',
        detail: `repo ${r.name}: ${r.packCount} packs (git repacks above ${r.autoPackLimit}); automatic gc is not running`,
        fix: { tier: 'consented', summary: 'too many git packs', command: `git -C "${r.repoPath}" gc` },
      });
    }
  }
  return out;
}
