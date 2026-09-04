/**
 * Removing a container karst started.
 *
 * A container is not its client. `docker run` attached gives karst a normal
 * child it can group-kill, but SIGKILLing that client detaches it from a
 * container that keeps running — port still bound, memory still held, and now
 * with nothing pointing at it. So every path that stops a karst server also
 * removes the container by NAME, which is the one handle that cannot go stale:
 * the OS reissues pids, docker does not reissue names.
 *
 * Two forms, because the callers differ:
 *
 *  - `removeContainer` is FIRE-AND-FORGET, for the synchronous stop and reap
 *    paths (`stopServer`, `stopServersUnder`) that run on the extension host's
 *    event loop, where `spawnSync` is banned outright. It never blocks, never
 *    throws, and never reports — `docker rm -f` on a container that is already
 *    gone is a no-op, which is what makes fire-and-forget honest here.
 *  - `removeContainerAsync` is AWAITABLE and bounded, for the one caller that
 *    must know the name is free before it acts: `startHot`, where a leftover
 *    container of the same name makes `docker run` fail on a name conflict.
 */

import { spawn } from 'node:child_process';
import { commandOutput } from './asyncProcess.js';

/** How long to wait for `docker rm -f` before giving up and starting anyway. */
const REMOVE_TIMEOUT_MS = 5_000;

export interface RemoveContainerOptions {
  /**
   * Verbose decision-point logging (§ debug logging), prefixed `[runtime]`.
   * Absent → no debug lines; the host binds it to `Logger.debug`.
   */
  debug?: (message: string) => void;
  /** Injected spawner, so tests never touch a real docker daemon. */
  spawnFn?: typeof spawn;
}

/**
 * Remove `name` without waiting for the result. Safe on every path: a missing
 * container exits non-zero and is ignored, a missing docker binary raises an
 * 'error' event that is listened for (an unheard one would throw in the host),
 * and the child is detached and unref'd so it can never hold the host open.
 */
export function removeContainer(name: string, opts: RemoveContainerOptions = {}): void {
  const spawnFn = opts.spawnFn ?? spawn;
  opts.debug?.(`[runtime] removing container ${name}`);
  try {
    const child = spawnFn('docker', ['rm', '-f', name], {
      stdio: 'ignore',
      detached: true,
      windowsHide: true,
    });
    // docker not installed, or not on this editor's PATH: nothing to remove and
    // nothing to report — but the event MUST be listened for, or node throws it.
    child.once('error', () => {});
    child.unref();
  } catch {
    /* best-effort: a stop must never fail over its own cleanup */
  }
}

/**
 * Remove `name` and wait (bounded) for docker to answer. Used before a start, so
 * a leftover container from a crashed run cannot block the new one by holding
 * its name. Resolves either way — a timeout or a missing daemon must not stop
 * the start attempt, which will produce its own, better error.
 */
export async function removeContainerAsync(
  name: string,
  opts: Pick<RemoveContainerOptions, 'debug'> = {},
): Promise<void> {
  opts.debug?.(`[runtime] clearing any leftover container named ${name}`);
  await commandOutput('docker', ['rm', '-f', name], REMOVE_TIMEOUT_MS);
}
