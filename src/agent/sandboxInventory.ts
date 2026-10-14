import { createHash } from 'node:crypto';
import { SBX_CORES } from './sbx/sbxRunner.js';
import { DOCKER_CORES } from './docker/dockerImage.js';
import type { SbxProcess, ProcessResult } from './sbx/sbxProcess.js';

export type SandboxRunnerKind = 'sbx' | 'docker';

/** One sandbox of THIS project, identity derived from its name (`karst-<hash8>-<id>-<core>`). */
export interface ProjectSandbox {
  readonly runner: SandboxRunnerKind;
  readonly name: string;
  readonly ticketId: number;
  readonly core: string;
  readonly state: 'running' | 'stopped';
}

export interface SandboxInventory {
  readonly sandboxes: readonly ProjectSandbox[];
  /** A runner whose listing failed (not installed, daemon down): reported, never fatal. */
  readonly errors: readonly string[];
}

const CORES_BY_RUNNER: Record<SandboxRunnerKind, readonly string[]> = { sbx: SBX_CORES, docker: DOCKER_CORES };

function projectPrefix(projectRoot: string): string {
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

function failure(cmd: string, r: ProcessResult): string {
  return `${cmd} failed: ${(r.stderr.trim() || r.stdout.trim()).split('\n')[0]!.slice(0, 200)}`;
}

function own(runner: SandboxRunnerKind, name: string, projectRoot: string, running: boolean): ProjectSandbox | undefined {
  const id = parseSandboxName(name, projectRoot);
  if (!id || !CORES_BY_RUNNER[runner].includes(id.core)) return undefined;
  return { runner, name, ...id, state: running ? 'running' : 'stopped' };
}

export interface InventoryDeps {
  readonly projectRoot: string;
  readonly sbx: SbxProcess;
  readonly docker: SbxProcess;
}

/**
 * Every sandbox this project owns, across both runners (async; never `spawnSync`).
 * Other projects' sandboxes are filtered out by the name prefix and never returned.
 */
export async function listProjectSandboxes(deps: InventoryDeps): Promise<SandboxInventory> {
  const sandboxes: ProjectSandbox[] = [];
  const errors: string[] = [];
  const ls = await deps.sbx.run('sbx', ['ls']);
  if (ls.code !== 0) errors.push(failure('sbx ls', ls));
  else {
    for (const line of ls.stdout.split('\n').slice(1)) {
      const [name, , status] = line.trim().split(/\s+/);
      const s = name ? own('sbx', name, deps.projectRoot, status === 'running') : undefined;
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
  }
  return { sandboxes, errors };
}
