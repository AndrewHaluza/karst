/**
 * The shell fragment that stops one service process group whose id is in `$p`
 * (D823). Every service stop script uses it: the sandbox scripts in
 * `sandboxServices.ts` and the direct-ssh `stopServicesScript`.
 *
 * - `$p` must be all digits and greater than 1: `kill -TERM -0` signals the
 *   caller's own group and `kill -TERM -1` signals every process of the user.
 * - The group operand is `-<pgid>` with no `--`: dash (Debian and Ubuntu
 *   `/bin/sh`) rejects `kill -- -<pgid>`, so only the leader would end.
 * - After TERM it waits for the group to exit, then sends KILL. A caller reuses
 *   the port next (a restart, or the remote port probe of a re-spin), so the
 *   old process must be gone when the fragment returns.
 *
 * A service started without `setsid` is no group leader: the pid operand is the
 * fallback for both the signal and the liveness check.
 */

/** TERM grace, in polls of {@link SERVICE_STOP_POLL_SECONDS}: 4 seconds. */
export const SERVICE_STOP_GRACE_POLLS = 20;
/** The KILL settle time, in polls: 1 second. */
export const SERVICE_KILL_SETTLE_POLLS = 5;
/** One poll. A `sleep` that rejects a fraction falls back to one second (25 s in all, under the 30 s exec bound). */
export const SERVICE_STOP_POLL_SECONDS = '0.2';

const ALIVE = 'kill -0 -"$p" 2>/dev/null || kill -0 "$p" 2>/dev/null';
const POLL = `sleep ${SERVICE_STOP_POLL_SECONDS} 2>/dev/null || sleep 1`;

function waitWhileAlive(polls: number): string {
  return `i=0; while { ${ALIVE}; } && [ "$i" -lt ${String(polls)} ]; do ${POLL}; i=$((i+1)); done; `;
}

/** One line of POSIX sh; every statement ends with `; `. */
export const KILL_SERVICE_GROUP =
  `case "$p" in ''|*[!0-9]*) p='' ;; esac; ` +
  'if [ -n "$p" ] && [ "$p" -gt 1 ]; then ' +
  'kill -TERM -"$p" 2>/dev/null || kill -TERM "$p" 2>/dev/null; ' +
  waitWhileAlive(SERVICE_STOP_GRACE_POLLS) +
  `if { ${ALIVE}; }; then kill -KILL -"$p" 2>/dev/null || kill -KILL "$p" 2>/dev/null; ` +
  waitWhileAlive(SERVICE_KILL_SETTLE_POLLS) + 'fi; ' +
  'fi; ';
