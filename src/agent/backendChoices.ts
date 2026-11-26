/**
 * Per-core sandbox backend choices (arch:AC-32). Dependency-free: the manifest
 * schema, the resolver and the Settings webview all import it.
 */
import type { AgentProvider } from '../manifest/types.js';
import { DOCKER_CORES, SBX_CORES, SSH_CORES } from './sandboxCores.js';

export type CoreBackend = 'host' | 'sbx' | 'docker' | `ssh:${string}`;

/** Every core a backend can be chosen for; agy is host only until it gets a sandbox (arch:AC-31). */
export const BACKEND_CORES = ['claude', 'codex', 'opencode', 'opencode2', 'agy'] as const;
export type BackendCore = (typeof BACKEND_CORES)[number];

/**
 * The session provider that serves each backend core (SET-46).
 *
 * The manifest vocabulary says `agy` while session providers say
 * `antigravity` (`backendCoreKey` maps between them), so the Settings Sandbox
 * panel must not hard-code the translation. One exhaustive map means a new core
 * is a `tsc` error here rather than a row that silently renders no identity.
 */
export const BACKEND_CORE_PROVIDER: Readonly<Record<BackendCore, AgentProvider>> = {
  claude: 'claude',
  codex: 'codex',
  opencode: 'opencode',
  opencode2: 'opencode2',
  agy: 'antigravity',
};

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

/** The remote name of an `ssh:<name>` backend; `undefined` for every other value (and a bare `ssh:`). */
export function parseSshBackend(backend: CoreBackend): string | undefined {
  if (!backend.startsWith('ssh:')) return undefined;
  const name = backend.slice('ssh:'.length);
  return name === '' ? undefined : name;
}

/** Whether a backend value selects an SSH remote (T1387). */
export function isSshBackend(backend: CoreBackend): backend is `ssh:${string}` {
  return parseSshBackend(backend) !== undefined;
}

/**
 * Whether a core can run over SSH (T1387): claude, codex, opencode and
 * opencode2. `agy` never can, because karst reads its conversation DB on the
 * host (@arch:AC-26).
 */
export function sshAllowed(core: string): boolean {
  return (SSH_CORES as readonly string[]).includes(backendCoreKey(core));
}

/** The backend one core is set to (absent → host). Exact key wins, then mapped key. */
export function backendForCore(backends: AgentBackends | undefined, core: string): CoreBackend {
  const map = backends as Readonly<Record<string, CoreBackend | undefined>> | undefined;
  return map?.[core] ?? map?.[backendCoreKey(core)] ?? 'host';
}

/** The sandbox backends some core selects (`host` excluded); every `ssh:*` value is `ssh`. */
export function selectedSandboxBackends(backends: AgentBackends | undefined): readonly ('sbx' | 'docker' | 'ssh')[] {
  const chosen = new Set<'sbx' | 'docker' | 'ssh'>();
  for (const backend of Object.values(backends ?? {})) {
    if (backend === undefined) continue;
    if (isSshBackend(backend)) chosen.add('ssh');
    else if (backend === 'sbx' || backend === 'docker') chosen.add(backend);
  }
  return (['sbx', 'docker', 'ssh'] as const).filter((b) => chosen.has(b));
}

/** The distinct remote names some core selects (`ssh:<name>`); empty when none. */
export function selectedRemotes(backends: AgentBackends | undefined): readonly string[] {
  const names: string[] = [];
  for (const backend of Object.values(backends ?? {})) {
    const name = backend === undefined ? undefined : parseSshBackend(backend);
    if (name !== undefined && !names.includes(name)) names.push(name);
  }
  return names;
}

/** Which sandbox backends a probe should preflight; the others are skipped. */
export interface BackendWant {
  readonly sbx: boolean;
  readonly docker: boolean;
  readonly ssh: boolean;
}

export function wantedBackends(backends: AgentBackends | undefined): BackendWant {
  const selected = selectedSandboxBackends(backends);
  return { sbx: selected.includes('sbx'), docker: selected.includes('docker'), ssh: selected.includes('ssh') };
}
