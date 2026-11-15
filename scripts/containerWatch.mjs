// Watchdog for a `docker run` client whose container does not exist (T1146).
//
// Incident 2026-11-15: a `docker run` client ran 9.5 h with no container and ignored SIGTERM, so the
// visual gate held its lease. The gate polls `docker ps -a` and kills a client that has no container.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export const EXIT_DOCKER_HUNG = 125;
export const WATCH_POLL_MS = 30_000;
export const WATCH_MISSES = 3;
export const GRACE_IMAGE_PRESENT_MS = 120_000;
export const GRACE_IMAGE_MISSING_MS = 900_000;
export const PROBE_TIMEOUT_MS = 10_000;

const IMAGE_PREFIX = 'mcr.microsoft.com/playwright:';

/** The pinned Playwright image in a docker argv, or null. */
export function imageOf(dockerArgs) {
  return dockerArgs.find((arg) => typeof arg === 'string' && arg.startsWith(IMAGE_PREFIX)) ?? null;
}

const stdoutOf = (result) => (typeof result === 'string' ? result : (result?.stdout ?? ''));

/** 'present' | 'absent' | 'unknown' for the container with this exact name. */
export async function probeContainer(name, execFileImpl = execFile) {
  try {
    const result = await promisify(execFileImpl)('docker', ['ps', '-a', '-q', '--filter', `name=^${name}$`], {
      timeout: PROBE_TIMEOUT_MS,
    });
    return String(stdoutOf(result)).trim() === '' ? 'absent' : 'present';
  } catch {
    return 'unknown';
  }
}

/** True when `docker image inspect` finds the image. */
export async function imagePresent(image, execFileImpl = execFile) {
  if (image === null) return false;
  try {
    await promisify(execFileImpl)('docker', ['image', 'inspect', image], { timeout: PROBE_TIMEOUT_MS });
    return true;
  } catch {
    return false;
  }
}

/** After the grace, poll the container. `misses` absent or unknown polls in a row call onHung one time. */
export function watchContainer({ name, graceMs, pollMs = WATCH_POLL_MS, misses = WATCH_MISSES, probe = probeContainer, onHung }) {
  let interval = null;
  let inFlight = false;
  let missed = 0;
  let stopped = false;
  const stop = () => {
    stopped = true;
    clearTimeout(graceTimer);
    if (interval !== null) clearInterval(interval);
    interval = null;
  };
  const tick = async () => {
    if (inFlight || stopped) return;
    inFlight = true;
    try {
      const state = await probe(name);
      if (stopped) return;
      missed = state === 'present' ? 0 : missed + 1;
      if (missed >= misses) {
        stop();
        onHung({ name, waitedMs: graceMs + misses * pollMs });
      }
    } finally {
      inFlight = false;
    }
  };
  const start = () => {
    interval = setInterval(tick, pollMs);
    interval.unref();
  };
  const graceTimer = setTimeout(start, graceMs);
  graceTimer.unref();
  return { stop };
}
