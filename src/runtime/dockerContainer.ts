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
 * Three forms, because the callers differ:
 *
 *  - `removeContainer` is FIRE-AND-FORGET, for the synchronous stop and reap
 *    paths (`stopServersUnder`, `reap`, `bootSweeps`, `startHot`'s failure
 *    path) that run on the extension host's event loop, where `spawnSync` is
 *    banned outright. It never blocks, never throws, and never reports —
 *    `docker rm -f` on a container that is already gone is a no-op, which is
 *    what makes fire-and-forget honest here.
 *  - `removeContainerAsync` is AWAITABLE and bounded, for the one caller that
 *    must know the name is free before it acts: `startHot`, where a leftover
 *    container of the same name makes `docker run` fail on a name conflict.
 *  - `removeContainerVerified` is AWAITABLE and verified, for `stopServer`: a
 *    server whose container cannot be removed must not report stopped, or it
 *    leaks on the machine and any later restart. The function awaits
 *    `docker rm -f` (bounded) and then confirms absence with one final
 *    `docker ps -a` query, rejecting when the container is still present.
 */

import { spawn } from 'node:child_process';
import { commandOutput } from './asyncProcess.js';

/** How long to wait for `docker rm -f` before giving up and starting anyway. */
const REMOVE_TIMEOUT_MS = 5_000;

/** A command executor, so tests can avoid any real spawn. */
export type CommandExecutor = (
  command: string,
  args: string[],
  timeoutMs: number,
  spawnFn: typeof spawn,
) => Promise<string | null>;

export interface RemoveContainerOptions {
  /**
   * Verbose decision-point logging (§ debug logging), prefixed `[runtime]`.
   * Absent → no debug lines; the host binds it to `Logger.debug`.
   */
  debug?: (message: string) => void;
  /** Injected spawner, so tests never touch a real docker daemon. */
  spawnFn?: typeof spawn;
  /** Injected command executor for testing; defaults to commandOutput. */
  commandOutput?: CommandExecutor;
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

/**
 * Remove `name`, await the answer, and then VERIFY it is gone.
 *
 * `stopServer`'s contract is that a stopped server is stopped: its row is
 * cleared truthfully, so a dashboard that shows it offline is showing a fact.
 * A fire-and-forget `docker rm -f` cannot promise that — the rm may have been
 * swallowed by a timeout, a daemon that was mid-shutdown, or a name that was
 * never the container's at all, and the container keeps running with its port
 * bound and nothing pointing at it. Every other stop path accepts that risk
 * because it has no row to clear; `stopServer` does not, because the row is the
 * evidence.
 *
 * The verification is a single `docker ps -aq` name query after the rm
 * settles. An empty string means the container is absent — that is the only
 * answer that resolves; a non-empty Id means it is still there, and the
 * function rejects so the caller can keep the row running and retry. A missing
 * docker binary or a daemon that will not answer also rejects: the caller
 * treats that as "not verified", not as "gone", because absence of evidence is
 * not evidence of absence.
 */
export async function removeContainerVerified(
  name: string,
  opts: RemoveContainerOptions = {},
): Promise<void> {
  opts.debug?.(`[runtime] removing container ${name} and verifying it is gone`);
  const spawnFn = opts.spawnFn ?? spawn;
  const exec = opts.commandOutput ?? ((...args) => commandOutput(...args));
  await exec('docker', ['rm', '-f', name], REMOVE_TIMEOUT_MS, spawnFn);
  // `docker ps -aq` exits 0 with empty output when nothing matches, and fails
  // (null) when docker is missing or the daemon is down — unlike `inspect`,
  // where "absent" and "daemon down" both look like a non-zero exit.
  const id = await exec(
    'docker',
    ['ps', '-aq', '--no-trunc', '--filter', `name=^/${name}$`],
    REMOVE_TIMEOUT_MS,
    spawnFn,
  );
  if (id === null) {
    opts.debug?.(`[runtime] cannot verify container ${name} is gone (docker did not answer)`);
    throw new Error(`cannot verify container ${name} is gone: docker did not answer`);
  }
  if (id.trim() !== '') {
    opts.debug?.(`[runtime] container ${name} still present after removal (${id.trim()})`);
    throw new Error(`container ${name} still present after removal (${id.trim()})`);
  }
  opts.debug?.(`[runtime] container ${name} is gone`);
}
