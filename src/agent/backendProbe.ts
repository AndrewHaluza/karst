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

/** The Docker VM's total memory in bytes (`docker info` MemTotal); undefined when it cannot be read. */
export async function probeDockerMemory(proc: SbxProcess = NODE_DOCKER_PROCESS): Promise<number | undefined> {
  try {
    const r = await proc.run('docker', ['info', '--format', '{{.MemTotal}}']);
    const n = Number(r.stdout.trim());
    return r.code === 0 && Number.isFinite(n) && n > 0 ? n : undefined;
  } catch {
    return undefined;
  }
}

/** "Docker VM 4.8 GB, 2 other karst/playwright containers running" for a killed setup's reason; undefined when nothing is readable. */
export async function dockerKillContext(proc: SbxProcess = NODE_DOCKER_PROCESS): Promise<string | undefined> {
  const mem = await probeDockerMemory(proc);
  let others: number | undefined;
  try {
    const r = await proc.run('docker', ['ps', '--format', '{{.Names}} {{.Image}}']);
    if (r.code === 0) others = r.stdout.split('\n').filter((l) => /karst-|playwright/i.test(l)).length;
  } catch {
    others = undefined;
  }
  const parts = [
    mem === undefined ? undefined : `Docker VM ${(mem / 2 ** 30).toFixed(1)} GB`,
    others === undefined ? undefined : `${others} karst/playwright container${others === 1 ? '' : 's'} running`,
  ].filter((x): x is string => x !== undefined);
  return parts.length ? parts.join(', ') : undefined;
}
