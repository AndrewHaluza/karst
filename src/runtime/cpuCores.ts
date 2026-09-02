import { cpus } from 'node:os';

let cachedCoreCount: number | null = null;

/**
 * Returns the number of logical CPU cores. Cached after first call.
 * Falls back to 1 if detection fails.
 */
export function getCpuCoreCount(): number {
  if (cachedCoreCount !== null) return cachedCoreCount;
  try {
    const list = cpus();
    const count = Array.isArray(list) && list.length > 0 ? list.length : 1;
    cachedCoreCount = count;
    return count;
  } catch {
    cachedCoreCount = 1;
    return 1;
  }
}

/** Reset cache for testing. */
export function __resetCpuCoreCountCache(): void {
  cachedCoreCount = null;
}