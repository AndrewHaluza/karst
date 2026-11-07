import { createHash } from 'node:crypto';
import { SBX_CORES } from './sbx/sbxRunner.js';
import { DOCKER_CORES } from './docker/dockerImage.js';
import { listSbx } from './sbx/sbxList.js';
import type { SbxProcess, ProcessResult } from './sbx/sbxProcess.js';

export type SandboxRunnerKind = 'sbx' | 'docker';

/** One sandbox of THIS project, identity derived from its name (`karst-<hash8>-<id>-<core>`). */
export interface ProjectSandbox {
  readonly runner: SandboxRunnerKind;
  readonly name: string;
  readonly ticketId: number;
  readonly core: string;
  readonly state: 'running' | 'stopped';
  /** Named for a core this runner cannot host (F6): never a live ticket's sandbox, always an orphan. */
  readonly invalidCore?: true;
}

export interface SandboxInventory {
  readonly sandboxes: readonly ProjectSandbox[];
  /** A runner whose listing failed (not installed, daemon down): reported, never fatal. */
  readonly errors: readonly string[];
}

const CORES_BY_RUNNER: Record<SandboxRunnerKind, readonly string[]> = { sbx: SBX_CORES, docker: DOCKER_CORES };

export function projectPrefix(projectRoot: string): string {
  return `karst-${createHash('sha256').update(projectRoot).digest('hex').slice(0, 8)}-`;
}

/** `{ticketId, core}` for this project's sandbox name; `undefined` for anything else (other project, sidecar, unknown core). */
export function parseSandboxName(name: string, projectRoot: string): { ticketId: number; core: string } | undefined {
  const prefix = projectPrefix(projectRoot);
  if (!name.startsWith(prefix)) return undefined;
  const m = /^([1-9][0-9]*)-([a-z0-9]+)$/.exec(name.slice(prefix.length));
  if (!m) return undefined;
  const core = m[2]!;
  if (!([...SBX_CORES, ...DOCKER_CORES] as readonly string[]).includes(core)) return undefined;
  return { ticketId: Number(m[1]), core };
}

export type SandboxContainerSuffix = 'proxy' | 'svc' | `port-${number}`;

/**
 * Like `parseSandboxName`, but also accepts a detached sandbox container's
 * `-proxy`, `-svc` and `-port-<N>` suffix. Those have no host pid, so the NAME
 * is the only handle that ties them to a ticket.
 */
export function parseSandboxContainerName(
  name: string,
  projectRoot: string,
): { ticketId: number; core: string; suffix: SandboxContainerSuffix | null } | undefined {
  const m = /^(.*?)(?:-(proxy|svc|port-[1-9][0-9]*))?$/.exec(name);
  const base = m?.[1] ?? name;
  const id = parseSandboxName(base, projectRoot);
  if (!id) return undefined;
  return { ...id, suffix: (m?.[2] as SandboxContainerSuffix | undefined) ?? null };
}

function failure(cmd: string, r: ProcessResult): string {
  return `${cmd} failed: ${(r.stderr.trim() || r.stdout.trim()).split('\n')[0]!.slice(0, 200)}`;
}

function own(runner: SandboxRunnerKind, name: string, projectRoot: string, running: boolean): ProjectSandbox | undefined {
  const state = running ? 'running' : 'stopped';
  const id = parseSandboxName(name, projectRoot);
  if (id && CORES_BY_RUNNER[runner].includes(id.core)) return { runner, name, ...id, state };
  // `karst-<hash>-<id>-<core>` of this project with a wrong core (null, agy, a docker core on sbx…): report it as an orphan.
  const m = /^([1-9][0-9]*)-([a-z0-9]+)$/.exec(name.startsWith(projectPrefix(projectRoot)) ? name.slice(projectPrefix(projectRoot).length) : '');
  return m ? { runner, name, ticketId: Number(m[1]), core: m[2]!, state, invalidCore: true } : undefined;
}

export interface InventoryDeps {
  readonly projectRoot: string;
  readonly sbx: SbxProcess;
  readonly docker: SbxProcess;
}

/** A docker sandbox's clone volume (`dockerNames().repoVolume`): its presence IS the sandbox, as `hasSandbox` reads it. */
const DOCKER_REPO_VOLUME_SUFFIX = '-repo';

/**
 * Every sandbox this project owns, across both runners (async; never `spawnSync`).
 * Docker: containers by name, plus a `-repo` volume with no container (state `stopped`).
 * Other projects' sandboxes are filtered out by the name prefix and never returned.
 */
export async function listProjectSandboxes(deps: InventoryDeps): Promise<SandboxInventory> {
  const sandboxes: ProjectSandbox[] = [];
  const errors: string[] = [];
  const ls = await listSbx(deps.sbx);
  if (ls.code !== 0) errors.push(failure('sbx ls', ls));
  else {
    for (const { name, running } of ls.entries) {
      const s = own('sbx', name, deps.projectRoot, running);
      if (s) sandboxes.push(s);
    }
  }
  const ps = await deps.docker.run('docker', [
    'ps', '-a', '--filter', `name=${projectPrefix(deps.projectRoot)}`, '--format', '{{.Names}}\t{{.State}}',
  ]);
  if (ps.code !== 0) errors.push(failure('docker ps', ps));
  else {
    for (const line of ps.stdout.split('\n')) {
      const [name, state] = line.trim().split('\t');
      const s = name ? own('docker', name, deps.projectRoot, state === 'running') : undefined;
      if (s) sandboxes.push(s);
    }
    const vols = await deps.docker.run('docker', [
      'volume', 'ls', '--filter', `name=${projectPrefix(deps.projectRoot)}`, '--format', '{{.Name}}',
    ]);
    if (vols.code !== 0) errors.push(failure('docker volume ls', vols));
    else {
      // The agent container is `--rm`: after a session ends only the volumes (and the proxy) remain.
      for (const line of vols.stdout.split('\n')) {
        const volume = line.trim();
        if (!volume.endsWith(DOCKER_REPO_VOLUME_SUFFIX)) continue;
        const name = volume.slice(0, -DOCKER_REPO_VOLUME_SUFFIX.length);
        if (sandboxes.some((s) => s.runner === 'docker' && s.name === name)) continue;
        const s = own('docker', name, deps.projectRoot, false);
        if (s) sandboxes.push(s);
      }
    }
  }
  return { sandboxes, errors };
}
