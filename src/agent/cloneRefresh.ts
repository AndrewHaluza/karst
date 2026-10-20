import type { SyncResult } from './sessionRunner.js';

/** Exit codes of {@link REFRESH_SCRIPT}. */
export const REFRESH_DIRTY = 3;
export const REFRESH_DIVERGED = 4;

/**
 * Runs INSIDE the sandbox (host → sandbox refresh, F8): `$1` branch, `$2` bundle
 * file. Fetches the host's bundle and fast-forwards the clone; uncommitted work
 * or divergence never overwrites anything (the dirty diff goes to stdout).
 */
export const REFRESH_SCRIPT = [
  "export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=safe.directory GIT_CONFIG_VALUE_0='*'",
  'if [ -n "$(git status --porcelain)" ]; then git status --short; git diff HEAD | head -c 20000; exit 3; fi',
  'git fetch -q "$2" "refs/heads/$1" || exit 1',
  'git merge-base --is-ancestor HEAD FETCH_HEAD || exit 4',
  'git merge -q --ff-only FETCH_HEAD || exit 1',
].join('\n');

/** Map the script's outcome to the runner result; `stdout` carries the dirty diff. */
export function refreshOutcome(code: number, stdout: string, stderr: string, branch: string): SyncResult {
  if (code === 0) return { ok: true, summary: `refreshed the sandbox clone of ${branch} from the host` };
  if (code === REFRESH_DIRTY) return { ok: false, reason: `the sandbox clone has uncommitted work; nothing was overwritten:\n${stdout.trim()}` };
  if (code === REFRESH_DIVERGED) return { ok: false, reason: `refused: the host's ${branch} diverged from the sandbox clone (never forced)` };
  return { ok: false, reason: `sandbox refresh failed: ${(stderr || stdout).trim()}` };
}
