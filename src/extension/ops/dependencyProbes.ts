import {
  dependencyRegistry,
  requiredFor,
  type Capability,
  type DependencyFault,
  type RequiredDependency,
} from '../../runtime/deps.js';
import { probeDependencyAsync, runProbeAsync, type ProbeRunner } from '../../runtime/depsAsync.js';
import type { AgentProvider } from '../../manifest/types.js';

/** How long one probe outcome is reused. A user re-check clears it sooner. */
export const PROBE_CACHE_TTL_MS = 60_000;

export interface DependencyProbeService {
  /** Faults of every dependency in the registry for the provider. */
  faults(provider: AgentProvider): Promise<DependencyFault[]>;
  /** Faults of the dependencies one capability needs. */
  capabilityFaults(capability: Capability, provider: AgentProvider): Promise<DependencyFault[]>;
  /**
   * True only when a settled, fresh probe already found a fault. Unknown (cold or
   * stale) is NOT blocked: a sync seam must not refuse on a missing answer. It
   * never waits and starts any probe it lacks. An action guard uses `capabilityFaults`.
   */
  isCapabilityKnownBlocked(capability: Capability, provider: AgentProvider): boolean;
  /** Drop every cached outcome. The next call runs new probes. */
  clear(): void;
}

export interface DependencyProbeOptions {
  readonly run?: ProbeRunner;
  readonly now?: () => number;
  readonly ttlMs?: number;
}

const cacheKey = (dep: RequiredDependency): string =>
  JSON.stringify([dep.binary, dep.unavailable, dep.ready?.args, dep.probeEnv]);

/**
 * Async, bounded, cached dependency probes. Never blocks the extension host: a
 * binary that does not exit becomes a `timedOut` fault that names it. Callers
 * in the cache window share one in-flight or settled probe per dependency.
 */
export function createDependencyProbes(options: DependencyProbeOptions = {}): DependencyProbeService {
  const run = options.run ?? ((b, a, e, c) => runProbeAsync(b, a, e, c));
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? PROBE_CACHE_TTL_MS;
  interface Entry {
    at: number;
    result: Promise<DependencyFault | undefined>;
    settled?: { fault: DependencyFault | undefined };
  }
  let cache = new Map<string, Entry>();

  const probe = (dep: RequiredDependency): Promise<DependencyFault | undefined> => {
    const key = cacheKey(dep);
    const hit = cache.get(key);
    if (hit && now() - hit.at < ttlMs) return hit.result;
    const result = probeDependencyAsync(dep, run);
    const entry: Entry = { at: now(), result };
    cache.set(key, entry);
    void result.then((fault) => {
      entry.settled = { fault };
    });
    return result;
  };

  const check = async (deps: readonly RequiredDependency[]): Promise<DependencyFault[]> => {
    const faults = await Promise.all(deps.map(probe));
    return faults.filter((f): f is DependencyFault => f !== undefined);
  };

  return {
    faults: (provider) => check(dependencyRegistry(provider)),
    capabilityFaults: (capability, provider) =>
      check(requiredFor(capability, dependencyRegistry(provider))),
    isCapabilityKnownBlocked: (capability, provider) => {
      let blocked = false;
      for (const dep of requiredFor(capability, dependencyRegistry(provider))) {
        const hit = cache.get(cacheKey(dep));
        if (!hit || now() - hit.at >= ttlMs) void probe(dep);
        else if (hit.settled?.fault) blocked = true;
      }
      return blocked;
    },
    clear: () => {
      cache = new Map();
    },
  };
}
