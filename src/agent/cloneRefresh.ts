import type { SyncResult } from './sessionRunner.js';

/** Exit codes of {@link REFRESH_SCRIPT}. */
export const REFRESH_DIRTY = 3;
export const REFRESH_DIVERGED = 4;

/** First stdout line of a dirty refusal: how many host commits the clone lacks. */
export const HOST_AHEAD_MARKER = 'karst-host-ahead';

const REFRESH_HEAD = "export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=safe.directory GIT_CONFIG_VALUE_0='*'";
const REFRESH_TAIL = [
  'git fetch -q "$2" "refs/heads/$1" || exit 1',
  'git merge-base --is-ancestor HEAD FETCH_HEAD || exit 4',
  'git merge -q --ff-only FETCH_HEAD || exit 1',
];

/**
 * Runs INSIDE the sandbox (host → sandbox refresh, F8): `$1` branch, `$2` bundle
 * file. Fetches the host's bundle and fast-forwards the clone; uncommitted work
 * or divergence never overwrites anything (the dirty diff goes to stdout, after
 * a first line counting the host commits the clone lacks).
 */
export const REFRESH_SCRIPT = [
  REFRESH_HEAD,
  'git fetch -q "$2" "refs/heads/$1" || exit 1',
  `if [ -n "$(git status --porcelain)" ]; then echo "${HOST_AHEAD_MARKER} $(git rev-list --count HEAD..FETCH_HEAD)"; git status --short; git diff HEAD | head -c 20000; exit 3; fi`,
  ...REFRESH_TAIL.slice(1),
].join('\n');

/**
 * The user-clicked variant (`$3` = stash message): park uncommitted work with
 * `git stash push -u` (recoverable, never discarded), then the normal refresh.
 */
export const STASH_REFRESH_SCRIPT = [
  REFRESH_HEAD,
  `if [ -n "$(git status --porcelain)" ]; then git stash push -u -m "$3" >/dev/null || exit 5; fi`,
  ...REFRESH_TAIL,
].join('\n');

/** Exit code of {@link STASH_REFRESH_SCRIPT} when the stash itself failed. */
export const REFRESH_STASH_FAILED = 5;

/** The stash message of a Stash-and-update click: names the ticket and when, so the work is findable. */
export function stashMessage(ticketLabel: string, now: Date = new Date()): string {
  return `karst: ${ticketLabel} before host update ${now.toISOString()}`;
}

/** Map the script's outcome to the runner result; `stdout` carries the dirty diff. */
export function refreshOutcome(code: number, stdout: string, stderr: string, branch: string): SyncResult {
  if (code === 0) return { ok: true, summary: `refreshed the sandbox clone of ${branch} from the host` };
  if (code === REFRESH_DIRTY) {
    const [first = '', ...rest] = stdout.split('\n');
    const ahead = first.startsWith(`${HOST_AHEAD_MARKER} `) ? Number(first.slice(HOST_AHEAD_MARKER.length + 1)) : NaN;
    if (Number.isInteger(ahead) && ahead > 0) {
      return { ok: false, reason: `sandbox has uncommitted work and the host is ahead by ${ahead} commit(s); nothing was overwritten:\n${rest.join('\n').trim()}` };
    }
    return { ok: false, reason: `the sandbox clone has uncommitted work; nothing was overwritten:\n${(Number.isNaN(ahead) ? stdout : rest.join('\n')).trim()}` };
  }
  if (code === REFRESH_STASH_FAILED) return { ok: false, reason: `sandbox stash failed; nothing was changed: ${(stderr || stdout).trim()}` };
  if (code === REFRESH_DIVERGED) return { ok: false, reason: `refused: the host's ${branch} diverged from the sandbox clone (never forced)` };
  return { ok: false, reason: `sandbox refresh failed: ${(stderr || stdout).trim()}` };
}
