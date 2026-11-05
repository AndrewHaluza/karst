import { toMb, VM_CEILING, DOCKER_MEMORY_PATTERN } from '../docker/dockerMemory.js';

const BYTES_PER_MB = 1024 * 1024;

/** Share of host RAM one sandbox may grow to when the manifest says nothing. */
export const SBX_MEMORY_SHARE = 0.4;
export const SBX_MEMORY_MIN_MB = 2048;
export const SBX_MEMORY_MAX_MB = 8192;
/** Used when the host will not say how much RAM it has. */
export const SBX_MEMORY_FALLBACK = '4g';
/** Free host memory below which a start waits in the queue. */
export const SBX_MIN_FREE_DEFAULT_MB = 1536;

const fmt = (mb: number): string => (mb % 1024 === 0 ? `${mb / 1024}g` : `${mb}m`);

/**
 * The `sbx run --memory` value: a ceiling, not a reservation. Default = 40% of host RAM clamped to 2–8 GB;
 * an explicit `sbxMemory` wins but never exceeds the same 85% ceiling `resolveDockerMemoryLimits` applies.
 * Unknown host RAM → the override as written, else a fixed fallback.
 */
export function resolveSbxMemory(hostRamBytes: number | undefined, override?: string): string {
  const known = hostRamBytes !== undefined && Number.isFinite(hostRamBytes) && hostRamBytes > 0;
  if (!known) return override !== undefined && DOCKER_MEMORY_PATTERN.test(override) ? override : SBX_MEMORY_FALLBACK;
  const totalMb = Math.floor(hostRamBytes / BYTES_PER_MB);
  const wanted =
    override !== undefined && DOCKER_MEMORY_PATTERN.test(override)
      ? toMb(override)
      : Math.min(SBX_MEMORY_MAX_MB, Math.max(SBX_MEMORY_MIN_MB, Math.floor(totalMb * SBX_MEMORY_SHARE)));
  return fmt(Math.max(1, Math.min(wanted, Math.floor(totalMb * VM_CEILING))));
}

/** Free-memory admission threshold in bytes (`sandboxMemory.sbxMinFree`, default 1.5 GB). */
export function resolveMinFreeBytes(override?: string): number {
  const mb = override !== undefined && DOCKER_MEMORY_PATTERN.test(override) ? toMb(override) : SBX_MIN_FREE_DEFAULT_MB;
  return mb * BYTES_PER_MB;
}

const gb = (bytes: number): string => (bytes / (1024 ** 3)).toFixed(1);

/** The ticket label while it waits: 'Waiting for memory (free 0.8 GB, needs 1.5 GB)'. */
export function waitingNote(freeBytes: number, needBytes: number): string {
  return `Waiting for memory (free ${gb(freeBytes)} GB, needs ${gb(needBytes)} GB)`;
}
