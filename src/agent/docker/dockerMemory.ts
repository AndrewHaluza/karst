import { DOCKER_BIN } from './dockerPreflight.js';
import type { DockerProcess } from './dockerProcess.js';

/** Docker `--memory` / `--memory-reservation` values for the interactive session and the one-shot gate. */
export interface DockerMemoryLimits {
  readonly interactiveMemory: string;
  readonly interactiveReservation: string;
  readonly gateMemory: string;
  readonly gateReservation: string;
}

/** The manifest's optional `sandboxMemory` overrides, in Docker's memory grammar (`2g`, `1536m`). */
export interface SandboxMemoryConfig {
  readonly interactiveMemory?: string;
  readonly interactiveReservation?: string;
  readonly gateMemory?: string;
  readonly gateReservation?: string;
}

/** What to use when the daemon will not say how much memory it has. */
export const FALLBACK_MEMORY_LIMITS: DockerMemoryLimits = {
  interactiveMemory: '2g',
  interactiveReservation: '1g',
  gateMemory: '3g',
  gateReservation: '1536m',
};

/** Grammar of a Docker memory value that karst accepts (positive integer + m|g). */
export const DOCKER_MEMORY_PATTERN = /^[1-9][0-9]*(?:[mMgG])$/;

/** No container may request more than this share of the Docker VM. */
const VM_CEILING = 0.85;
const BYTES_PER_MB = 1024 * 1024;

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

function toMb(value: string): number {
  const n = Number(value.slice(0, -1));
  return value.slice(-1).toLowerCase() === 'g' ? n * 1024 : n;
}

/** Auto-scaled MB for one limit: `share` of the VM, clamped to `[min, max]`. */
function scaled(totalMb: number, share: number, min: number, max: number): number {
  return clamp(Math.floor(totalMb * share), min, max);
}

/**
 * Container memory limits sized to the Docker VM (`docker info` MemTotal). Unknown → fixed
 * fallback. Explicit `override` values win over the auto-scale; with a known VM size
 * every value is then capped at 85% of it, so `docker run` never asks for more than exists.
 */
export function resolveDockerMemoryLimits(memTotalBytes: number | undefined, override: SandboxMemoryConfig = {}): DockerMemoryLimits {
  const known = memTotalBytes !== undefined && Number.isFinite(memTotalBytes) && memTotalBytes > 0;
  const totalMb = known ? Math.floor(memTotalBytes / BYTES_PER_MB) : 0;
  const ceiling = Math.floor(totalMb * VM_CEILING);
  const pick = (explicit: string | undefined, auto: number | undefined, fallback: string): string => {
    const wanted = explicit !== undefined ? toMb(explicit) : auto;
    if (wanted === undefined) return explicit ?? fallback;
    if (!known || wanted <= ceiling) return explicit ?? `${wanted}m`;
    return `${Math.max(1, ceiling)}m`;
  };
  const auto = (share: number, min: number, max: number): number | undefined => (known ? scaled(totalMb, share, min, max) : undefined);
  const f = FALLBACK_MEMORY_LIMITS;
  return {
    interactiveMemory: pick(override.interactiveMemory, auto(0.45, 1024, 4096), f.interactiveMemory),
    interactiveReservation: pick(override.interactiveReservation, auto(0.25, 512, 2048), f.interactiveReservation),
    gateMemory: pick(override.gateMemory, auto(0.55, 1536, 6144), f.gateMemory),
    gateReservation: pick(override.gateReservation, auto(0.3, 768, 3072), f.gateReservation),
  };
}

/** `docker info --format '{{.MemTotal}}'` in bytes, or undefined when the daemon will not say. Never throws. */
export async function queryDockerMemTotal(proc: DockerProcess): Promise<number | undefined> {
  try {
    const out = await proc.run(DOCKER_BIN, ['info', '--format', '{{.MemTotal}}']);
    if (out.code !== 0) return undefined;
    const bytes = Number(out.stdout.trim());
    return Number.isInteger(bytes) && bytes > 0 ? bytes : undefined;
  } catch {
    return undefined;
  }
}
