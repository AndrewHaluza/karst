import { SANDBOX_NETWORK_ALLOWLIST } from '../sandbox.js';
import { PROXY_PORT } from './allowlistProxy.js';
import { OPENCODE_IMAGE } from './dockerImage.js';
import { bindMount } from './dockerRunArgs.js';
import { detail, DOCKER_BIN } from './dockerPreflight.js';
import type { DockerProcess } from './dockerProcess.js';

/** opencode's own endpoints (ST2B exp 8): `models.opencode.ai` is covered by the suffix. */
export const OPENCODE_PROVIDER_DOMAINS: readonly string[] = ['opencode.ai', 'openrouter.ai', 'models.dev'];

export const DOCKER_ALLOWLIST: readonly string[] = [...SANDBOX_NETWORK_ALLOWLIST, ...OPENCODE_PROVIDER_DOMAINS];

/** The proxy's name on the ticket network; the agent container's `HTTPS_PROXY` points here. */
export const PROXY_ALIAS = 'karst-proxy';
export const PROXY_URL = `http://${PROXY_ALIAS}:${PROXY_PORT}`;
const SCRIPT_IN_CONTAINER = '/opt/karst/allowlist-proxy.mjs';

export interface SidecarSpec {
  readonly proxy: string;
  readonly network: string;
  /** Host path of the bundled `allowlist-proxy.mjs`, mounted read-only. */
  readonly scriptPath: string;
  readonly allow?: readonly string[];
}

export type SidecarResult = { readonly ok: true } | { readonly ok: false; readonly reason: string };

/** `docker run` argv for the proxy: on the internal ticket network under the alias, unprivileged. */
export function sidecarRunArgs(spec: SidecarSpec): string[] {
  return [
    'run', '--detach', '--name', spec.proxy,
    '--network', spec.network, '--network-alias', PROXY_ALIAS,
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '--env', `ALLOW=${(spec.allow ?? DOCKER_ALLOWLIST).join(',')}`,
    '--mount', bindMount(spec.scriptPath, SCRIPT_IN_CONTAINER, true),
    OPENCODE_IMAGE, 'node', SCRIPT_IN_CONTAINER,
  ];
}

/**
 * Start the proxy unless it already runs, then give it (and only it) a second,
 * routable network: the ticket network is `--internal`, so the proxy is the
 * agent container's single way out.
 */
export async function startProxySidecar(proc: DockerProcess, spec: SidecarSpec): Promise<SidecarResult> {
  const state = await proc.run(DOCKER_BIN, ['container', 'inspect', '--format', '{{.State.Running}}', spec.proxy]);
  if (state.code === 0 && state.stdout.trim() === 'true') return { ok: true };
  if (state.code === 0) await proc.run(DOCKER_BIN, ['rm', '--force', spec.proxy]);
  const run = await proc.run(DOCKER_BIN, sidecarRunArgs(spec));
  if (run.code !== 0) return { ok: false, reason: `proxy sidecar failed to start: ${detail(run)}` };
  const egress = await proc.run(DOCKER_BIN, ['network', 'connect', 'bridge', spec.proxy]);
  if (egress.code !== 0) {
    await stopProxySidecar(proc, spec.proxy);
    return { ok: false, reason: `proxy sidecar has no egress network: ${detail(egress)}` };
  }
  return { ok: true };
}

export async function stopProxySidecar(proc: DockerProcess, proxy: string): Promise<void> {
  await proc.run(DOCKER_BIN, ['rm', '--force', proxy]);
}
