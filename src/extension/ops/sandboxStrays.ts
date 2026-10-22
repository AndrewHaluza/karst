import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { parseSandboxName, projectPrefix, type SandboxInventory } from '../../agent/sandboxInventory.js';
import { removeSbxClone, sandboxProjectDir } from '../../agent/sbx/sbxClone.js';
import type { SbxProcess } from '../../agent/sbx/sbxProcess.js';

/** A karst-owned object left behind with no sandbox: a clone dir, a docker volume, network or proxy container. */
export interface Stray {
  readonly kind: 'clone-dir' | 'volume' | 'network' | 'proxy';
  readonly name: string;
  /** `false` while its ticket is still open: reported, never removed (another window may be using it). */
  readonly removable: boolean;
}

export interface StrayDeps {
  readonly projectRoot: string;
  readonly docker: SbxProcess;
  /** Open (non-archived) ticket ids of this project. */
  readonly liveTicketIds: ReadonlySet<number>;
  readonly listCloneDirs?: (root: string) => Promise<readonly string[]>;
}

const DOCKER_SUFFIX = /-(repo|data|net|proxy)$/;

async function readNames(root: string): Promise<readonly string[]> {
  try {
    return await readdir(root);
  } catch {
    return [];
  }
}

async function lines(docker: SbxProcess, args: string[]): Promise<string[]> {
  const out = await docker.run('docker', args);
  return out.code === 0 ? out.stdout.split('\n').map((l) => l.trim()).filter(Boolean) : [];
}

function ticketOf(name: string, projectRoot: string): number | undefined {
  const base = name.replace(DOCKER_SUFFIX, '');
  return parseSandboxName(base, projectRoot)?.ticketId;
}

/** Everything this project owns on the host that no listed sandbox accounts for. Pure listing; removes nothing. */
export async function findStrays(deps: StrayDeps, inv: SandboxInventory): Promise<Stray[]> {
  // A runner whose listing failed proves nothing stray.
  const sbxOk = !inv.errors.some((e) => e.startsWith('sbx '));
  const dockerOk = !inv.errors.some((e) => e.startsWith('docker '));
  const known = new Set(inv.sandboxes.map((s) => s.name));
  const strays: Stray[] = [];
  const add = (kind: Stray['kind'], name: string, base: string): void => {
    const id = ticketOf(base, deps.projectRoot);
    if (id !== undefined && !known.has(base.replace(DOCKER_SUFFIX, ''))) strays.push({ kind, name, removable: !deps.liveTicketIds.has(id) });
  };
  if (sbxOk) {
    const root = join(sandboxProjectDir(deps.projectRoot), '.karst', 'sbx-clones');
    for (const dir of await (deps.listCloneDirs ?? readNames)(root)) add('clone-dir', dir, dir);
  }
  if (dockerOk) {
    const prefix = projectPrefix(deps.projectRoot);
    for (const v of await lines(deps.docker, ['volume', 'ls', '-q', '--filter', `name=${prefix}`])) add('volume', v, v);
    for (const n of await lines(deps.docker, ['network', 'ls', '--format', '{{.Name}}', '--filter', `name=${prefix}`])) add('network', n, n);
    for (const c of await lines(deps.docker, ['ps', '-a', '--filter', `name=${prefix}`, '--format', '{{.Names}}'])) {
      if (c.endsWith('-proxy')) add('proxy', c, c);
    }
  }
  return strays;
}

/** Remove the removable strays (closed or deleted tickets); returns the failures. Never throws. */
export async function removeStrays(deps: StrayDeps, strays: readonly Stray[]): Promise<string[]> {
  const failed: string[] = [];
  for (const s of strays) {
    if (!s.removable) continue;
    try {
      if (s.kind === 'clone-dir') {
        await removeSbxClone(join(sandboxProjectDir(deps.projectRoot), '.karst', 'sbx-clones', s.name));
        continue;
      }
      const args = s.kind === 'volume' ? ['volume', 'rm', '--force', s.name] : s.kind === 'network' ? ['network', 'rm', s.name] : ['rm', '--force', s.name];
      const out = await deps.docker.run('docker', args);
      if (out.code !== 0 && !/no such/i.test(out.stderr)) failed.push(`${s.kind} ${s.name}: ${out.stderr.trim().split('\n')[0] ?? ''}`);
    } catch (err) {
      failed.push(`${s.kind} ${s.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return failed;
}
