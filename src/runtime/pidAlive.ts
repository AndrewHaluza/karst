/**
 * `process.kill(pid, 0)` — does a process with this id exist right now?
 *
 * A permission-denied answer (EPERM) still PROVES it exists: the signal was
 * refused, not undelivered. Only ESRCH means gone. Reading EPERM as "dead" is
 * how a live process gets treated as a leak.
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
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}
