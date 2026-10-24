import { access } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { RUNTIME_ASSETS_ROOT } from '../../runtimeAssetsRoot.js';
import { opencode2Command, opencode2Config, opencode2IsolationEnv } from '../opencode2Binary.js';
import type { SandboxTicketRef, SessionRunner } from '../sessionRunner.js';
import type { StepResult } from './dockerClone.js';
import { isDockerCore } from './dockerImage.js';
import { queryDockerMemTotal, resolveDockerMemoryLimits, type SandboxMemoryConfig } from './dockerMemory.js';
import { dockerNames, type DockerNames } from './dockerNames.js';
import { dockerPreflight, type DockerPreflight } from './dockerPreflight.js';
import { NODE_DOCKER_PROCESS, type DockerProcess } from './dockerProcess.js';
import type { LinuxUser } from './dockerRunArgs.js';
import { createDockerSessionRunner, prepareDockerSandbox, type PrepareInput } from './dockerRunner.js';

/** Where `copy-assets` puts the Dockerfile and the build puts the proxy bundle. */
export const DOCKER_ASSETS_DIR = join(RUNTIME_ASSETS_ROOT, 'sandbox', 'opencode');

/** Every host fact the docker backend reads, injectable for tests. */
export interface DockerResolveDeps {
  readonly proc?: DockerProcess;
  readonly preflight?: (proc: DockerProcess, contextDir: string) => Promise<DockerPreflight>;
  readonly prepare?: (input: PrepareInput) => Promise<StepResult>;
  readonly platform?: NodeJS.Platform;
  readonly uid?: number;
  readonly gid?: number;
  readonly assetsDir?: string;
  /** The host opencode v1 `auth.json` when it exists. */
  readonly hostAuthFile?: () => Promise<string | undefined>;
  readonly opencode2Host?: () => { readonly command: string; readonly env: Readonly<Record<string, string>> };
  readonly debug?: (message: string) => void;
  /** Baseline host ports the sandbox may reach through its proxy (arch:AC-32). */
  readonly hostPorts?: readonly number[];
  /** The manifest's `sandboxMemory` overrides, applied over the VM-scaled defaults. */
  readonly sandboxMemory?: SandboxMemoryConfig;
}

export interface DockerResolveInput {
  readonly core: string;
  readonly projectRoot: string;
  readonly ticketId: number;
  readonly worktree: SandboxTicketRef | undefined;
  readonly deps?: DockerResolveDeps;
}

export type DockerResolution =
  | { readonly ok: true; readonly runner: SessionRunner; readonly names: DockerNames }
  | { readonly ok: false; readonly reason: string };

/** Linux needs the host uid inside the container (ST2B blocker 5); Docker Desktop maps it itself. */
export function linuxUser(platform: NodeJS.Platform, uid: number | undefined, gid: number | undefined): LinuxUser | undefined {
  return platform === 'linux' && uid !== undefined && gid !== undefined ? { uid, gid } : undefined;
}

async function defaultHostAuthFile(): Promise<string | undefined> {
  const dataHome = process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share');
  const file = join(dataHome, 'opencode', 'auth.json');
  try {
    await access(file);
    return file;
  } catch {
    return undefined; // no v1 sign-in on this host: launch without the mount
  }
}

function defaultOpencode2Host(): { command: string; env: Record<string, string> } {
  return { command: opencode2Command(), env: opencode2IsolationEnv(opencode2Config().home) };
}

/** The docker half of `resolveBackend`: a prepared runner, or the one reason it cannot be used. Never throws. */
export async function resolveDocker(input: DockerResolveInput): Promise<DockerResolution> {
  const deps = input.deps ?? {};
  if (!isDockerCore(input.core)) return { ok: false, reason: `${input.core}: docker backend unsupported` };
  if (!input.worktree?.branch) return { ok: false, reason: 'docker: ticket has no worktree branch to clone' };
  try {
    const names = dockerNames({ projectRoot: input.projectRoot, ticketId: input.ticketId, core: input.core });
    const proc = deps.proc ?? NODE_DOCKER_PROCESS;
    const assetsDir = deps.assetsDir ?? DOCKER_ASSETS_DIR;
    const check = await (deps.preflight ?? dockerPreflight)(proc, assetsDir);
    if (!check.ok) return check;
    const memory = resolveDockerMemoryLimits(await queryDockerMemTotal(proc), deps.sandboxMemory);
    const user = linuxUser(deps.platform ?? process.platform, deps.uid ?? process.getuid?.(), deps.gid ?? process.getgid?.());
    const prepared = await (deps.prepare ?? prepareDockerSandbox)({
      proc, core: input.core, names, user, ticket: input.worktree,
      proxyScript: join(assetsDir, 'allowlist-proxy.mjs'),
      ...(input.core === 'opencode2' ? { opencode2Host: (deps.opencode2Host ?? defaultOpencode2Host)() } : {}),
      ...(deps.debug ? { debug: deps.debug } : {}),
      ...(deps.hostPorts && deps.hostPorts.length > 0 ? { hostPorts: deps.hostPorts } : {}),
    });
    if (!prepared.ok) return prepared;
    const authFile = input.core === 'opencode' ? await (deps.hostAuthFile ?? defaultHostAuthFile)() : undefined;
    const runner = createDockerSessionRunner({ proc, core: input.core, names, user, memory, ...(authFile ? { authFile } : {}) });
    return { ok: true, runner, names };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}
