/**
 * Per-core sandbox backend choices (arch:AC-32). Dependency-free: the manifest
 * schema, the resolver and the Settings webview all import it.
 */
import { DOCKER_CORES, SBX_CORES } from './sandboxCores.js';

export type CoreBackend = 'host' | 'sbx' | 'docker';

/** Every core a backend can be chosen for; agy is host only until it gets a sandbox (arch:AC-31). */
export const BACKEND_CORES = ['claude', 'codex', 'opencode', 'opencode2', 'agy'] as const;
export type BackendCore = (typeof BACKEND_CORES)[number];

/** `Manifest.agentBackends`: absent key = host. */
export type AgentBackends = { readonly [C in BackendCore]?: CoreBackend };

/**
 * Canonical key for looking up a core in `AgentBackends` maps.
 * Manifest keys and Settings use 'agy', while session providers use 'antigravity'.
 */
export function backendCoreKey(core: string): string {
  return core === 'antigravity' ? 'agy' : core;
}

/** The values a core can be set to; host is always first. */
export function allowedBackends(core: string): readonly CoreBackend[] {
  const key = backendCoreKey(core);
  if ((SBX_CORES as readonly string[]).includes(key)) return ['host', 'sbx'];
  if ((DOCKER_CORES as readonly string[]).includes(key) || (DOCKER_CORES as readonly string[]).includes(core)) return ['host', 'docker'];
  return ['host'];
}

/** The backend one core is set to (absent → host). Exact key wins, then mapped key. */
export function backendForCore(backends: AgentBackends | undefined, core: string): CoreBackend {
  const map = backends as Readonly<Record<string, CoreBackend | undefined>> | undefined;
  return map?.[core] ?? map?.[backendCoreKey(core)] ?? 'host';
}

/** The sandbox backends some core selects (`host` excluded). */
export function selectedSandboxBackends(backends: AgentBackends | undefined): readonly ('sbx' | 'docker')[] {
  const chosen = new Set(Object.values(backends ?? {}));
  return (['sbx', 'docker'] as const).filter((b) => chosen.has(b));
}

/** Which sandbox backends a probe should preflight; the others are skipped. */
export interface BackendWant {
  readonly sbx: boolean;
  readonly docker: boolean;
}

export function wantedBackends(backends: AgentBackends | undefined): BackendWant {
  const selected = selectedSandboxBackends(backends);
  return { sbx: selected.includes('sbx'), docker: selected.includes('docker') };
}
