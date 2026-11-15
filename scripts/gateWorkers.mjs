// The worker count of a local docker visual or layout gate (@ui:WORKERS).
//
// Only the docker branch of scripts/dockerGate.mjs uses it: only that branch
// knows that a container runs next and can read the CPU count of the Docker VM.
// Inside the container, tests/visual/visualWorkers.ts validates the value, and
// CI and --update-snapshots runs stay at 1 worker.

import { execFile } from 'node:child_process';

/** The maximum default worker count. */
export const GATE_WORKERS_CAP = 4;

/** The CPUs that stay free for the Playwright runner, the fixture server and the VM. */
export const RESERVED_CPUS = 2;

/** The time limit of `docker info`. */
export const DOCKER_INFO_TIMEOUT_MS = 10_000;

const WORKERS_ENV = 'KARST_VISUAL_WORKERS';

/** The CPU count of `docker info --format {{.NCPU}}`, or null when the output is not a positive integer. */
export function parseDockerCpus(stdout) {
  const text = String(stdout ?? '').trim();
  if (!/^[1-9]\d*$/.test(text)) return null;
  return Number(text);
}

/**
 * The worker count, as the string that the container gets in KARST_VISUAL_WORKERS.
 * An explicit KARST_VISUAL_WORKERS (also '') wins. Else min(4, CPUs - 2), minimum 1.
 * An unknown CPU count gives 1.
 * @returns {{ workers: string, source: 'env' | 'docker' | 'fallback' }}
 */
export function gateWorkers({ env, cpus }) {
  const explicit = env[WORKERS_ENV];
  if (explicit !== undefined) return { workers: explicit, source: 'env' };
  if (!Number.isInteger(cpus) || cpus <= 0) return { workers: '1', source: 'fallback' };
  const workers = Math.max(1, Math.min(GATE_WORKERS_CAP, cpus - RESERVED_CPUS));
  return { workers: String(workers), source: 'docker' };
}

/** The log line that says the worker count and where it came from. */
export function workersLine({ workers, source, cpus }) {
  const count = `${workers} ${workers === '1' ? 'worker' : 'workers'}`;
  if (source === 'env') return `visual: ${count} (${WORKERS_ENV})`;
  if (source === 'docker') return `visual: ${count} (docker ${cpus} CPUs; ${WORKERS_ENV} overrides)`;
  return `visual: ${count} (docker CPU count unknown)`;
}

/**
 * The CPU count of the Docker VM, or null when `docker info` fails, times out or cannot start.
 * Async: a sync call would block the signal handlers of the gate.
 */
export function dockerCpus(exec = execFile) {
  return new Promise((resolve) => {
    try {
      exec('docker', ['info', '--format', '{{.NCPU}}'], { encoding: 'utf8', timeout: DOCKER_INFO_TIMEOUT_MS }, (error, stdout) => {
        resolve(error ? null : parseDockerCpus(stdout));
      });
    } catch {
      // docker cannot start: the caller falls back to 1 worker.
      resolve(null);
    }
  });
}
