import type { AgentBackend } from '../manifest/types.js';
import { DOCKER_CORES, SBX_CORES } from './sandboxCores.js';

/** Result of a backend's preflight, reduced to what the UI needs. */
export type BackendStatus = { readonly ok: true } | { readonly ok: false; readonly reason: string };

export interface EffectiveBackend {
  readonly core: string;
  readonly backend: AgentBackend;
  /** Why the core is on host; absent when it runs in its sandbox. */
  readonly reason?: string;
}

export interface EffectiveBackendInput {
  readonly setting: AgentBackend | undefined;
  readonly cores: readonly string[];
  readonly sbx: BackendStatus;
  readonly docker: BackendStatus;
}

const HOST_SETTING_REASON = 'agentBackend: host';

/**
 * Pure mirror of `resolveBackend`'s decision per core (arch:AC-31/AC-32): a core
 * the chosen backend cannot run, or a failed preflight, resolves to host with the
 * reason. Never picks a sandbox the preflight did not clear.
 */
export function deriveEffectiveBackends(input: EffectiveBackendInput): readonly EffectiveBackend[] {
  const setting = input.setting ?? 'host';
  return input.cores.map((core) => resolveCore(setting, core, input));
}

function resolveCore(setting: AgentBackend, core: string, input: EffectiveBackendInput): EffectiveBackend {
  const onHost = (reason: string): EffectiveBackend => ({ core, backend: 'host', reason });
  if (setting === 'host') return onHost(HOST_SETTING_REASON);
  const supported = setting === 'sbx' ? (SBX_CORES as readonly string[]).includes(core) : (DOCKER_CORES as readonly string[]).includes(core);
  if (!supported) return onHost(`${setting} backend unsupported`);
  const status = setting === 'sbx' ? input.sbx : input.docker;
  return status.ok ? { core, backend: setting } : onHost(status.reason);
}

/** `claude: sbx · opencode: docker · agy: host (sbx backend unsupported)`. */
export function formatEffectiveBackends(rows: readonly EffectiveBackend[]): string {
  return rows
    .map((r) => (r.backend !== 'host' || r.reason === undefined || r.reason === HOST_SETTING_REASON ? `${r.core}: ${r.backend}` : `${r.core}: host (${r.reason})`))
    .join(' · ');
}
