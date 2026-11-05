import { toMb } from '../docker/dockerMemory.js';

export const SBX_CPUS_MIN = 2;
export const SBX_CPUS_MAX = 4;
/** Share of the sandbox memory limit a node process may use as heap. */
export const SBX_HEAP_SHARE = 0.5;
const HEAP_FLAG = '--max-old-space-size';

/**
 * The `sbx run --cpus` value: max(2, floor(host CPUs / 2)) clamped to 4. A manifest override wins unclamped.
 * An unknown host CPU count gives the minimum.
 */
export function resolveSbxCpus(hostCpus: number | undefined, override?: number): number {
  if (override !== undefined) return override;
  if (hostCpus === undefined || !Number.isFinite(hostCpus) || hostCpus < 1) return SBX_CPUS_MIN;
  return Math.min(SBX_CPUS_MAX, Math.max(SBX_CPUS_MIN, Math.floor(hostCpus / 2)));
}

export interface LimitEnvInput {
  readonly cpus: number;
  /** The sbx memory ceiling (`resolveSbxMemory`); absent → no heap flag. */
  readonly memory?: string;
  /** An existing NODE_OPTIONS to extend. */
  readonly nodeOptions?: string;
  /** Manifest opt-out (`sandboxLimits.workers: false`): no variables at all. */
  readonly optOut?: boolean;
}

/** Worker and heap variables for a sandbox session or gate. NODE_OPTIONS is merged, never replaced. */
export function limitEnvEntries(input: LimitEnvInput): [string, string][] {
  if (input.optOut) return [];
  const out: [string, string][] = [
    ['VITEST_MAX_THREADS', String(input.cpus)],
    ['VITEST_MAX_FORKS', String(input.cpus)],
  ];
  const existing = input.nodeOptions?.trim() ?? '';
  if (existing.includes(HEAP_FLAG)) {
    out.push(['NODE_OPTIONS', existing]);
  } else if (input.memory !== undefined) {
    const heap = `${HEAP_FLAG}=${Math.max(1, Math.floor(toMb(input.memory) * SBX_HEAP_SHARE))}`;
    out.push(['NODE_OPTIONS', existing === '' ? heap : `${existing} ${heap}`]);
  } else if (existing !== '') {
    out.push(['NODE_OPTIONS', existing]);
  }
  return out;
}

/** The same variables as `--env KEY=VALUE` argv pairs for `sbx run` / `sbx exec`. */
export function limitEnvArgs(input: LimitEnvInput): string[] {
  return limitEnvEntries(input).flatMap(([k, v]) => ['--env', `${k}=${v}`]);
}

/** The manifest's optional `sandboxLimits` mapping. */
export interface SandboxLimitsConfig {
  /** `sbx run --cpus` on create (default `resolveSbxCpus`). */
  readonly cpus?: number;
  /** false = do not set the vitest worker and node heap variables (per-repo opt-out). Default true. */
  readonly workers?: boolean;
  /** Project-wide gate slots across tickets: default 2, 0 = unlimited. */
  readonly gateSlots?: number;
}

export const DEFAULT_GATE_SLOTS = 2;

/** The gate slot count: the manifest value, else the default. 0 means unlimited. */
export function resolveGateSlots(config?: SandboxLimitsConfig): number {
  return config?.gateSlots ?? DEFAULT_GATE_SLOTS;
}

/** What `createSbxSessionRunner` needs from the host and the manifest. */
export function resolveSbxLimits(hostCpus: number | undefined, config?: SandboxLimitsConfig): { cpus: number; limitWorkers: boolean } {
  return { cpus: resolveSbxCpus(hostCpus, config?.cpus), limitWorkers: config?.workers !== false };
}
