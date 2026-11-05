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
    // vitest 4 reads only VITEST_MAX_WORKERS (MAX_THREADS / MAX_FORKS were removed).
    ['VITEST_MAX_WORKERS', String(input.cpus)],
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

/** The heap flag for a sandbox memory ceiling, or undefined when none is set. */
export function heapOption(memory: string | undefined): string | undefined {
  return memory === undefined ? undefined : `${HEAP_FLAG}=${Math.max(1, Math.floor(toMb(memory) * SBX_HEAP_SHARE))}`;
}

/**
 * Wrap a gate command so the GUEST's own NODE_OPTIONS is extended, not replaced (`sbx exec --env` would replace it).
 * A heap flag the guest already sets wins. Without a heap option the command is unchanged.
 */
export function wrapWithHeap(command: string, args: readonly string[], memory: string | undefined): { command: string; args: string[] } {
  const heap = heapOption(memory);
  if (heap === undefined) return { command, args: [...args] };
  const script = `case "$NODE_OPTIONS" in *${HEAP_FLAG}*) ;; *) export NODE_OPTIONS="\${NODE_OPTIONS:+$NODE_OPTIONS }${heap}";; esac; exec "$@"`;
  return { command: 'sh', args: ['-c', script, 'sh', command, ...args] };
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
