import { readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { RemoteDef } from '../../manifest/types.js';
import { parseSandboxName, projectPrefix, type SandboxInventory } from '../../agent/sandboxInventory.js';
import { OPENCODE_IMAGE_REVISION } from '../../agent/docker/dockerImage.js';
import { removeSbxClone, sandboxProjectDir } from '../../agent/sbx/sbxClone.js';
import type { SbxProcess } from '../../agent/sbx/sbxProcess.js';
import { isRemoteTrusted, readRemoteTrust } from '../../agent/ssh/remoteTrust.js';
import { sshControlDir } from '../../agent/ssh/sshControlDir.js';
import { sshProjectPrefix } from '../../agent/ssh/sshNames.js';
import { sshArgv, sshDest, type SshProcess } from '../../agent/ssh/sshProcess.js';
import { sshQuote } from '../../agent/ssh/sshQuote.js';

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
  /** Revoke the proxy key and remove the policy rule of the sandbox a clone dir belonged to (@arch:AC-51). */
  readonly releaseGrant?: (sandbox: string) => Promise<void>;
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
        await deps.releaseGrant?.(s.name);
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

/** Marker lines of the one per-remote stray script, so dirs and assets never mix. */
export const REMOTE_STRAY_DIRS_MARKER = '__KARST_STRAY_DIRS__';
export const REMOTE_STRAY_ASSETS_MARKER = '__KARST_STRAY_ASSETS__';

/**
 * One ssh call lists the remote dir and its `.karst-assets` children. The
 * caller classifies them: a dir of this install's prefix that no listed
 * sandbox accounts for is a half-made workspace; an asset revision no listed
 * docker workspace uses is unused.
 */
export function remoteStraysScript(remoteDir: string): string {
  const dir = sshQuote(remoteDir.replace(/\/+$/, ''));
  return [
    '# karst-ssh-strays',
    `printf '%s\\n' ${sshQuote(REMOTE_STRAY_DIRS_MARKER)}`,
    `ls -1 ${dir} 2>/dev/null`,
    `printf '%s\\n' ${sshQuote(REMOTE_STRAY_ASSETS_MARKER)}`,
    `ls -1 ${dir}/.karst-assets 2>/dev/null`,
    'exit 0',
  ].join('\n');
}

function nonEmptyLines(text: string): string[] {
  return text.split('\n').map((l) => l.trim()).filter((l) => l !== '' && l !== '.' && l !== '..');
}

/** The names of `<remoteDir>` and those of `<remoteDir>/.karst-assets`. */
export function parseRemoteStrays(stdout: string): { dirs: readonly string[]; assets: readonly string[] } {
  const dirsAt = stdout.indexOf(REMOTE_STRAY_DIRS_MARKER);
  const assetsAt = stdout.indexOf(REMOTE_STRAY_ASSETS_MARKER);
  const dirsPart = dirsAt < 0 ? '' : stdout.slice(dirsAt + REMOTE_STRAY_DIRS_MARKER.length, assetsAt < 0 ? undefined : assetsAt);
  const assetsPart = assetsAt < 0 ? '' : stdout.slice(assetsAt + REMOTE_STRAY_ASSETS_MARKER.length);
  return { dirs: nonEmptyLines(dirsPart), assets: nonEmptyLines(assetsPart) };
}

export type RemoteStrayKind = 'half-made' | 'assets' | 'forgotten';

/** A remote object no listed sandbox accounts for. Reported, never removed here (D830 owns the forgotten Delete). */
export interface RemoteStray {
  readonly kind: RemoteStrayKind;
  readonly remote: string;
  readonly name: string;
  readonly path: string;
  /** The ticket of a forgotten record; a half-made dir and an asset revision name none. */
  readonly ticketId?: number;
}

/** The outcome of the `ssh -O check` of one ControlMaster socket (D554). */
export interface ControlSocketCheck {
  readonly socket: string;
  readonly removed: boolean;
  readonly reason?: string;
}

export interface RemoteStrayReport {
  /** Ticket-less remote strays, apart from the sockets. */
  readonly strays: readonly RemoteStray[];
  /** ControlMaster sockets (they belong to no ticket: `%C` is the connection hash). */
  readonly sockets: readonly ControlSocketCheck[];
  /** `ssh <remote>: <reason>`; an unconfirmed remote is reported, never swept. */
  readonly errors: readonly string[];
}

export interface RemoteStrayDeps {
  readonly projectRoot: string;
  readonly remotes: Readonly<Record<string, RemoteDef>>;
  readonly installId: string;
  /** The dir of `ssh-trust.json` and `ssh-strays.json` (globalStorage). */
  readonly trustDir: string;
  readonly ssh: SshProcess;
  /** The ControlMaster dir; defaults to `sshControlDir()`. */
  readonly controlDir?: string;
  /** The listing just read: a remote whose listing failed is unknown, never all-stray. */
  readonly inventory: SandboxInventory;
  /** Test seams for the host control dir. */
  readonly listSockets?: (dir: string) => Promise<readonly string[]>;
  readonly unlink?: (path: string) => Promise<void>;
}

/** `%C` is ssh's 40-char connection hash; only such a name can be a karst socket. */
const CONTROL_SOCKET_RE = /^[0-9a-f]{40}$/;

async function socketNames(dir: string): Promise<readonly string[]> {
  try {
    return await readdir(dir);
  } catch {
    // Stryker disable next-line ArrayDeclaration: equivalent, the sweep drops every name that is not a socket
    return [];
  }
}

/** `ssh -O check` for one socket; the destination is irrelevant to the check, the socket answers. */
function controlCheckArgv(def: RemoteDef, socket: string): string[] {
  return ['-O', 'check', '-o', `ControlPath=${socket}`, '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-p', String(def.port ?? 22), '--', sshDest(def)];
}

/**
 * A socket is removed only when `ssh -O check` fails (no live master): `%C` is
 * shared by every window, so a live one may belong to a session this sweep
 * cannot see. Reported apart from the ticket items.
 */
async function sweepControlSockets(deps: RemoteStrayDeps): Promise<ControlSocketCheck[]> {
  const trusted = Object.entries(deps.remotes).filter(([name, def]) => isRemoteTrusted(readRemoteTrust(deps.trustDir), name, def));
  if (trusted.length === 0) return [];
  const [, def] = trusted[0]!;
  const dir = deps.controlDir ?? sshControlDir();
  const names = [...await (deps.listSockets ?? socketNames)(dir)].sort();
  const out: ControlSocketCheck[] = [];
  for (const name of names) {
    if (!CONTROL_SOCKET_RE.test(name)) continue;
    const socket = join(dir, name);
    const check = await deps.ssh.run(controlCheckArgv(def, socket));
    if (check.code === 0) {
      out.push({ socket, removed: false });
      continue;
    }
    try {
      await (deps.unlink ?? unlink)(socket);
      out.push({ socket, removed: true });
    } catch (err) {
      out.push({ socket, removed: false, reason: err instanceof Error ? err.message : String(err) });
    }
  }
  return out;
}

/**
 * The remote half of the stray sweep (D824, edit 4): per TRUSTED remote, the
 * half-made workspaces of this install's prefix, the asset revisions no listed
 * docker workspace uses, and the dead ControlMaster sockets. A forgotten
 * record (`stray: true`) comes from the inventory and makes no extra call.
 */
export async function findRemoteStrays(deps: RemoteStrayDeps): Promise<RemoteStrayReport> {
  const strays: RemoteStray[] = [];
  const errors: string[] = [];
  for (const box of deps.inventory.sandboxes) {
    if (box.stray === true && box.remote !== undefined) {
      const remoteDir = deps.remotes[box.remote]?.remoteDir.replace(/\/+$/, '');
      strays.push({ kind: 'forgotten', remote: box.remote, name: box.name, path: remoteDir === undefined ? box.name : `${remoteDir}/${box.name}`, ticketId: box.ticketId });
    }
  }
  const remoteDirOf = (def: RemoteDef): string => def.remoteDir.replace(/\/+$/, '');
  for (const [name, def] of Object.entries(deps.remotes)) {
    // Trust first (D553 C1): an unconfirmed remote gets NO ssh call, not even a listing.
    if (!isRemoteTrusted(readRemoteTrust(deps.trustDir), name, def)) {
      // The inventory reports the same reason; do not log it twice at reconcile.
      const reason = `ssh ${name}: ssh remote ${name} not confirmed`;
      if (!deps.inventory.errors.includes(reason)) errors.push(reason);
      continue;
    }
    // Its inventory failed: which dirs are listed is unknown, so none is "stray".
    if (deps.inventory.errors.some((e) => e.startsWith(`ssh ${name}:`))) continue;
    const out = await deps.ssh.run(sshArgv(def, deps.controlDir ?? sshControlDir(), remoteStraysScript(def.remoteDir)), {
      maxStdoutBytes: 256 * 1024,
      signal: AbortSignal.timeout(20_000),
    });
    if (out.transport === true || out.code !== 0) {
      // After the whole-text trim, the last line is the last non-blank line ('' for no stderr).
      const lines = out.stderr.trim().split('\n');
      const detail = lines[lines.length - 1]!;
      errors.push(`ssh ${name}: stray sweep failed${detail === '' ? '' : `: ${detail}`}`);
      continue;
    }
    const parsed = parseRemoteStrays(out.stdout);
    const listed = new Set(deps.inventory.sandboxes.filter((s) => s.runner === 'ssh' && s.remote === name).map((s) => s.name));
    const prefix = `${sshProjectPrefix(deps.projectRoot, deps.installId)}-`;
    for (const dir of parsed.dirs) {
      if (!dir.startsWith(prefix) || listed.has(dir)) continue;
      strays.push({ kind: 'half-made', remote: name, name: dir, path: `${remoteDirOf(def)}/${dir}` });
    }
    // Only a docker-mode workspace mounts an asset revision; a remote with no listed workspace uses none.
    const usedAssets = def.mode === 'docker' && listed.size > 0 ? new Set([OPENCODE_IMAGE_REVISION]) : new Set<string>();
    for (const asset of parsed.assets) {
      if (usedAssets.has(asset)) continue;
      strays.push({ kind: 'assets', remote: name, name: asset, path: `${remoteDirOf(def)}/.karst-assets/${asset}` });
    }
  }
  return { strays, sockets: await sweepControlSockets(deps), errors };
}

/** The user-facing lines of a remote stray sweep (the reconcile logs them, never throws). */
export function describeRemoteStrays(report: RemoteStrayReport): string[] {
  const lines = report.errors.map((e) => `karst: ${e}`);
  for (const s of report.strays) {
    if (s.kind === 'half-made') lines.push(`karst: ssh ${s.remote}: half-made remote workspace ${s.path}`);
    else if (s.kind === 'assets') lines.push(`karst: ssh ${s.remote}: unused remote assets ${s.path}`);
    else lines.push(`karst: ssh ${s.remote}: forgotten remote workspace ${s.path} (delete it from the ticket)`);
  }
  for (const s of report.sockets) {
    if (s.removed) lines.push(`karst: removed stale ssh control socket ${s.socket}`);
    else if (s.reason !== undefined) lines.push(`karst: could not remove stale ssh control socket ${s.socket}: ${s.reason}`);
  }
  return lines;
}
