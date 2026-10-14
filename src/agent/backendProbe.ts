import { parseDockerSize } from '../doctor/sandboxChecks.js';
import type { BackendWant } from './backendChoices.js';
import type { BackendStatus } from './effectiveBackend.js';
import { sbxPreflight } from './sbx/sbxPreflight.js';
import { NODE_SBX_PROCESS, type SbxProcess } from './sbx/sbxProcess.js';
import { dockerPreflight } from './docker/dockerPreflight.js';
import { DOCKER_ASSETS_DIR } from './docker/resolveDocker.js';
import { NODE_DOCKER_PROCESS } from './docker/dockerProcess.js';

export interface BackendProbes {
  readonly sbx: BackendStatus;
  readonly docker: BackendStatus;
}

/**
 * Readiness of the wanted sandbox backends (the rest are skipped and read `not selected`), via the same preflights `resolveBackend`
 * runs (arch:AC-31), so the status the UI shows is the decision a session start
 * would make. Never throws.
 */
export async function probeBackends(want: BackendWant = { sbx: true, docker: true }): Promise<BackendProbes> {
  const [sbx, docker] = await Promise.all([
    want.sbx ? sbxPreflight(NODE_SBX_PROCESS) : NOT_SELECTED,
    want.docker ? dockerPreflight(NODE_DOCKER_PROCESS, DOCKER_ASSETS_DIR) : NOT_SELECTED,
  ]);
  return { sbx: toStatus(sbx), docker: toStatus(docker) };
}

const NOT_SELECTED = { ok: false, reason: 'not selected' } as const;

function toStatus(p: { readonly ok: true } | { readonly ok: false; readonly reason: string }): BackendStatus {
  return p.ok ? { ok: true } : { ok: false, reason: p.reason };
}

/** Approximate bytes used by karst docker containers (`docker ps -a --size`); undefined when it cannot be read. */
export async function probeDockerDisk(proc: SbxProcess = NODE_DOCKER_PROCESS): Promise<number | undefined> {
  try {
    const r = await proc.run('docker', ['ps', '-a', '--size', '--filter', 'name=karst-', '--format', '{{.Size}}']);
    if (r.code !== 0) return undefined;
    let total = 0;
    for (const line of r.stdout.split('\n').filter((l) => l.trim() !== '')) {
      const n = parseDockerSize(line);
      if (n === undefined) return undefined;
      total += n;
    }
    return total;
  } catch {
    return undefined;
  }
}
