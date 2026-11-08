/**
 * Guest page-cache reclaimer for sbx sandboxes.
 *
 * The guest gives freed process memory back to the host by itself, but its page cache stays in host RAM
 * until the sandbox stops (measured: 1454 MB held on the host, 194 MB after a drop). `guestMemoryScript()`
 * builds one shell script that starts a guest loop. The loop drops the page cache when the guest is idle.
 * The script needs passwordless `sudo` in the guest; karst runs it with `sudo -n` and never blocks on a failure.
 *
 * Guest swap is absent on purpose: a swap file on `/var/lib/docker` damaged the guest Docker database
 * at the sbx hard auto-stop (3 of 3 times).
 */

/** First line of the script: lets test doubles and logs recognise the call. */
export const GUEST_MEMORY_MARKER = '# karst-guest-memory';
/** Reclaimer pid and loop files: /run is a tmpfs cleared on every sandbox start, so a restart starts a fresh loop. */
export const RECLAIM_PID_FILE = '/run/karst-reclaim.pid';
export const RECLAIM_LOOP_FILE = '/run/karst-reclaim.sh';
export const RECLAIM_INTERVAL_S = 60;
/** 1-minute guest load below which the guest counts as idle. */
export const RECLAIM_MAX_LOAD = '0.30';
/** Drop only when the page cache is above this (kB, `Cached:` in /proc/meminfo). */
export const RECLAIM_MIN_CACHED_KB = 262_144;
/** How often one runner re-runs the script (each run is one `sbx exec`). */
export const GUEST_MEMORY_RECHECK_MS = 300_000;

const HEREDOC_TAG = 'KARST_RECLAIM';

export function guestMemoryScript(): string {
  return [
    GUEST_MEMORY_MARKER,
    'set -u',
    `if [ -f ${RECLAIM_PID_FILE} ] && kill -0 "$(cat ${RECLAIM_PID_FILE})" 2>/dev/null; then exit 0; fi`,
    `cat > ${RECLAIM_LOOP_FILE} <<'${HEREDOC_TAG}'`,
    `echo $$ > ${RECLAIM_PID_FILE}`,
    `while sleep ${RECLAIM_INTERVAL_S}; do`,
    `  l=$(cut -d' ' -f1 /proc/loadavg)`,
    `  c=$(awk '/^Cached:/{print $2}' /proc/meminfo)`,
    `  if awk -v l="$l" 'BEGIN{exit !(l < ${RECLAIM_MAX_LOAD})}' && [ "\${c:-0}" -gt ${RECLAIM_MIN_CACHED_KB} ]; then sync; echo 1 > /proc/sys/vm/drop_caches; fi`,
    'done',
    HEREDOC_TAG,
    `nohup sh ${RECLAIM_LOOP_FILE} </dev/null >/dev/null 2>&1 &`,
  ].join('\n');
}
