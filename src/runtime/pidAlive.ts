import { readFileSync } from 'node:fs';

/**
 * `process.kill(pid, 0)` — does a process with this id exist right now?
 *
 * A permission-denied answer (EPERM) still PROVES it exists: the signal was
 * refused, not undelivered. Only ESRCH means gone. Reading EPERM as "dead" is
 * how a live process gets treated as a leak.
 *
 * A pid that ANSWERS the probe is not necessarily RUNNING: a process that has
 * exited and not been reaped is a ZOMBIE, and a zombie still answers. It holds
 * nothing but its exit status — no ports, no files, no compute — so it is
 * reported dead, which is what every caller of this helper actually asks
 * ("is the recorded server still up?"). The distinction is not academic: a
 * host whose init never reaps an orphan (a container without an init reaper)
 * keeps the zombie around long after the kill that made it, so a kill's
 * contract ("the process is gone") could otherwise never be observed.
 *
 * A pid is a recollection, never a handle — the OS reissues them — so this
 * answers only "something with this id is running", never "it is still the
 * thing we recorded". Callers that act destructively must attribute first
 * (`runtime/serverIdentity.ts`); callers that only decide whether a RECORD is
 * stale can use it directly, since the worst a reused pid does there is leave a
 * dead run marked running for one more activation.
 */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
  return !exitedUnreaped(pid);
}

/**
 * True when the pid names a process that has EXITED but not been reaped.
 *
 * Linux only: `/proc/<pid>/stat` carries the state (`Z` for a zombie). Where
 * there is no `/proc` (macOS, Windows) the answer is false — an orphan there is
 * reaped by the system and its pid disappears, so a pid that answers IS a
 * running process.
 */
function exitedUnreaped(pid: number): boolean {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    // `pid (comm) state ...` — the comm may contain spaces AND parentheses,
    // so the state is the field right after the LAST closing parenthesis.
    return stat.slice(stat.lastIndexOf(')') + 1).trimStart().startsWith('Z');
  } catch {
    // No `/proc` (or a process we may not read): the zero-signal probe stands.
    return false;
  }
}
