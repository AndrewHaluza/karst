import { createHash } from 'node:crypto';
import type { RemoteDef } from '../manifest/types.js';
import { SBX_CORES } from './sbx/sbxRunner.js';
import { DOCKER_CORES } from './docker/dockerImage.js';
import { SSH_CORES } from './sandboxCores.js';
import { listSbx } from './sbx/sbxList.js';
import type { SbxProcess, ProcessResult } from './sbx/sbxProcess.js';
import { isRemoteTrusted, readRemoteTrust } from './ssh/remoteTrust.js';
import { sshControlDir } from './ssh/sshControlDir.js';
import { sshDockerProcess } from './ssh/sshDockerProcess.js';
import { sshProjectPrefix } from './ssh/sshNames.js';
import { NODE_SSH_PROCESS, sshArgv, type SshProcess, type SshResult } from './ssh/sshProcess.js';
import { sshQuote } from './ssh/sshQuote.js';
import { readSshStrays } from './ssh/sshStrays.js';

export type SandboxRunnerKind = 'sbx' | 'docker' | 'ssh';

/** One sandbox of THIS project, identity derived from its name (`karst-<hash8>-<id>-<core>`). */
export interface ProjectSandbox {
  readonly runner: SandboxRunnerKind;
  readonly name: string;
  readonly ticketId: number;
  readonly core: string;
  readonly state: 'running' | 'stopped';
  /** Named for a core this runner cannot host (F6): never a live ticket's sandbox, always an orphan. */
  readonly invalidCore?: true;
  /** The `remotes.<name>` an ssh workspace lives on; absent for a local runner. */
  readonly remote?: string;
  /** A forgotten remote workspace (D830 record): never picked, stopped or removed, only listed as a stray. */
  readonly stray?: true;
}

export interface SandboxInventory {
  readonly sandboxes: readonly ProjectSandbox[];
  /** A runner whose listing failed (not installed, daemon down): reported, never fatal. */
  readonly errors: readonly string[];
}

const CORES_BY_RUNNER: Record<SandboxRunnerKind, readonly string[]> = { sbx: SBX_CORES, docker: DOCKER_CORES, ssh: SSH_CORES };

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

/**
 * An ssh workspace name of this project on one remote: `<prefix>-<ticketId>-<core>`,
 * where the prefix hashes the project path AND this install's id (D555), so
 * another editor's or machine's workspaces on a shared VM never match.
 */
function sshOwn(name: string, remote: string, prefixWithDash: string, running: boolean): ProjectSandbox | undefined {
  if (!name.startsWith(prefixWithDash)) return undefined;
  const m = /^([1-9][0-9]*)-([a-z0-9]+)$/.exec(name.slice(prefixWithDash.length));
  if (!m) return undefined;
  const core = m[2]!;
  if (!(SSH_CORES as readonly string[]).includes(core)) return undefined;
  return { runner: 'ssh', name, remote, ticketId: Number(m[1]), core, state: running ? 'running' : 'stopped' };
}

export interface InventoryDeps {
  readonly projectRoot: string;
  readonly sbx: SbxProcess;
  readonly docker: SbxProcess;
  /** The manifest's `remotes`: EVERY declared remote is listed (a ticket can select one no core selects, D827). */
  readonly remotes?: Readonly<Record<string, RemoteDef>>;
  /** The ssh seam; `NODE_SSH_PROCESS` when a remote is listed and none is injected. */
  readonly ssh?: SshProcess;
  /** `<globalStorage>/ssh/install-id`: ssh names hash it, so another install's dirs never match. */
  readonly installId?: string;
  /** The dir of `ssh-trust.json`: an unconfirmed remote gets NO ssh call (D553 C1). */
  readonly trustDir?: string;
  /** The checked ControlMaster dir; defaults to `sshControlDir()`. */
  readonly controlDir?: string;
  /** Corrupt trust/strays files are reported here, never thrown. */
  readonly warn?: (message: string) => void;
}

/** The per-remote listing bound (a hung ssh must not hold the boot sweep). */
export const SSH_INVENTORY_TIMEOUT_MS = 20_000;

/** A docker sandbox's clone volume (`dockerNames().repoVolume`): its presence IS the sandbox, as `hasSandbox` reads it. */
const DOCKER_REPO_VOLUME_SUFFIX = '-repo';

interface DockerListing {
  readonly sandboxes: readonly ProjectSandbox[];
  readonly errors: readonly string[];
}

/**
 * `docker ps -a` + `docker volume ls` for one prefix, sharing the parsing of the
 * local and the remote (`mode: docker`) daemon: a `-repo` volume with no
 * container is a stopped sandbox (the agent container is `--rm`), and a failing
 * `ps` skips the volume listing.
 */
async function listDocker(
  docker: SbxProcess,
  filterPrefix: string,
  parse: (name: string, running: boolean) => ProjectSandbox | undefined,
  signal?: AbortSignal,
): Promise<DockerListing> {
  const sandboxes: ProjectSandbox[] = [];
  const errors: string[] = [];
  const opts = signal === undefined ? undefined : { signal };
  const ps = await docker.run('docker', [
    'ps', '-a', '--filter', `name=${filterPrefix}`, '--format', '{{.Names}}\t{{.State}}',
  ], opts);
  if (ps.code !== 0) {
    errors.push(failure('docker ps', ps));
    return { sandboxes, errors };
  }
  for (const line of ps.stdout.split('\n')) {
    const [name, state] = line.trim().split('\t');
    const s = name ? parse(name, state === 'running') : undefined;
    if (s) sandboxes.push(s);
  }
  const vols = await docker.run('docker', [
    'volume', 'ls', '--filter', `name=${filterPrefix}`, '--format', '{{.Name}}',
  ], opts);
  if (vols.code !== 0) {
    errors.push(failure('docker volume ls', vols));
    return { sandboxes, errors };
  }
  // The agent container is `--rm`: after a session ends only the volumes (and the proxy) remain.
  for (const line of vols.stdout.split('\n')) {
    const volume = line.trim();
    if (!volume.endsWith(DOCKER_REPO_VOLUME_SUFFIX)) continue;
    const name = volume.slice(0, -DOCKER_REPO_VOLUME_SUFFIX.length);
    if (sandboxes.some((s) => s.name === name)) continue;
    const s = parse(name, false);
    if (s) sandboxes.push(s);
  }
  return { sandboxes, errors };
}

/** Marker lines of the one per-remote script, so `ls` and `tmux ls` output never mix. */
const DIRS_MARKER = '__KARST_DIRS__';
const TMUX_MARKER = '__KARST_TMUX__';

/** One ssh call lists the remote dir and the live tmux sessions (`#S` is the session name). */
export function remoteInventoryScript(remoteDir: string): string {
  return [
    '# karst-ssh-inventory',
    `printf '%s\\n' ${sshQuote(DIRS_MARKER)}`,
    `ls -1 ${sshQuote(remoteDir)} 2>/dev/null`,
    `printf '%s\\n' ${sshQuote(TMUX_MARKER)}`,
    `tmux ls -F '#S' 2>/dev/null`,
    'exit 0',
  ].join('\n');
}

function nonEmptyLines(text: string): string[] {
  return text.split('\n').map((l) => l.trim()).filter((l) => l !== '');
}

/** The dir names and live tmux session names of one remote listing. */
export function parseRemoteInventory(stdout: string): { names: readonly string[]; tmux: ReadonlySet<string> } {
  const dirsAt = stdout.indexOf(DIRS_MARKER);
  const tmuxAt = stdout.indexOf(TMUX_MARKER);
  const dirsPart = dirsAt < 0 ? '' : stdout.slice(dirsAt + DIRS_MARKER.length, tmuxAt < 0 ? undefined : tmuxAt);
  const tmuxPart = tmuxAt < 0 ? '' : stdout.slice(tmuxAt + TMUX_MARKER.length);
  const names = nonEmptyLines(dirsPart).filter((n) => n !== '.' && n !== '..');
  return { names, tmux: new Set(nonEmptyLines(tmuxPart)) };
}

/** The last non-empty stderr line, capped: ssh puts the cause at the end. */
function tail(text: string): string {
  const line = text.trim().split('\n').filter((l) => l.trim() !== '').at(-1);
  return line === undefined ? '' : line.slice(0, 300);
}

/**
 * The bindings `listProjectSandboxes` needs for the ssh listing, taken from the
 * SAME deps `sshRunnerFor` reads (one source of remotes, install id and trust).
 * Absent source = no ssh listing, so the local listing stays byte-identical.
 */
export interface SshInventorySource {
  readonly remotes: () => Readonly<Record<string, RemoteDef>> | undefined;
  readonly installId: () => string | undefined;
  /** The dir of `ssh-trust.json` and `ssh-strays.json` (globalStorage). */
  readonly globalStorageDir: string;
  readonly ssh?: SshProcess;
  readonly controlDir?: string;
  readonly warn?: (message: string) => void;
}

export function inventorySshDeps(source: SshInventorySource | undefined): Partial<InventoryDeps> {
  if (source === undefined) return {};
  const remotes = source.remotes();
  if (remotes === undefined) return {};
  const installId = source.installId();
  return {
    remotes,
    trustDir: source.globalStorageDir,
    ...(installId === undefined ? {} : { installId }),
    ...(source.ssh === undefined ? {} : { ssh: source.ssh }),
    ...(source.controlDir === undefined ? {} : { controlDir: source.controlDir }),
    ...(source.warn === undefined ? {} : { warn: source.warn }),
  };
}

/** The ssh-only listing reads no local runner. */
export type RemoteInventoryDeps = Omit<InventoryDeps, 'sbx' | 'docker'>;

interface RemoteListing {
  readonly sandboxes: readonly ProjectSandbox[];
  readonly errors: readonly string[];
}

/** List one declared remote; a failure or an unconfirmed remote is per-remote, never fatal. */
async function listRemote(name: string, def: RemoteDef, deps: RemoteInventoryDeps): Promise<RemoteListing> {
  const fail = (reason: string): RemoteListing => ({ sandboxes: [], errors: [`ssh ${name}: ${reason}`] });
  const trust = deps.trustDir === undefined ? {} : readRemoteTrust(deps.trustDir, deps.warn);
  // Trust first (D553 C1): an unconfirmed remote gets NO ssh call at all.
  if (!isRemoteTrusted(trust, name, def)) return fail(`ssh remote ${name} not confirmed`);
  const installId = deps.installId;
  if (installId === undefined) return fail('install id missing');
  const prefixWithDash = `${sshProjectPrefix(deps.projectRoot, installId)}-`;
  const strays = deps.trustDir === undefined ? [] : readSshStrays(deps.trustDir, deps.warn);
  const isStray = (sandboxName: string): boolean =>
    strays.some((s) => s.remote === name && s.path === `${def.remoteDir}/${sandboxName}`);
  const mark = (s: ProjectSandbox): ProjectSandbox => (isStray(s.name) ? { ...s, stray: true as const } : s);
  const signal = AbortSignal.timeout(SSH_INVENTORY_TIMEOUT_MS);
  const controlDir = deps.controlDir ?? sshControlDir();
  if (def.mode === 'docker') {
    // The remote daemon through the same docker backend (D822), filtered by the SSH prefix (which carries the install id).
    const proc = sshDockerProcess(def, deps.ssh ?? NODE_SSH_PROCESS, { controlDir });
    const listing = await listDocker(proc, prefixWithDash, (n, running) => sshOwn(n, name, prefixWithDash, running), signal);
    return {
      sandboxes: listing.sandboxes.map(mark),
      errors: listing.errors.map((e) => `ssh ${name}: ${e}`),
    };
  }
  const out: SshResult = await (deps.ssh ?? NODE_SSH_PROCESS).run(sshArgv(def, controlDir, remoteInventoryScript(def.remoteDir)), {
    maxStdoutBytes: 256 * 1024,
    signal,
  });
  if (out.transport === true) return fail(`transport failed: ${tail(out.stderr)}`);
  if (out.code !== 0) {
    const detail = tail(out.stderr);
    return fail(`listing failed (exit ${String(out.code)})${detail === '' ? '' : `: ${detail}`}`);
  }
  const parsed = parseRemoteInventory(out.stdout);
  const sandboxes = parsed.names
    .map((n) => sshOwn(n, name, prefixWithDash, parsed.tmux.has(n)))
    .filter((s): s is ProjectSandbox => s !== undefined)
    .map(mark);
  // A live gate pgid without a tmux session is not cheaply readable from here; the tmux session is the status source.
  return { sandboxes, errors: [] };
}

/**
 * Every sandbox this project owns, across the local runners and every declared
 * ssh remote (async; never `spawnSync`). Other projects' sandboxes are filtered
 * out by the name prefix and never returned; one remote failing never hides the
 * others or the local backends.
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
  const docker = await listDocker(deps.docker, projectPrefix(deps.projectRoot), (name, running) => own('docker', name, deps.projectRoot, running));
  sandboxes.push(...docker.sandboxes);
  errors.push(...docker.errors);
  const remote = await listRemoteSandboxes(deps);
  return { sandboxes: [...sandboxes, ...remote.sandboxes], errors: [...errors, ...remote.errors] };
}

/**
 * The ssh part of `listProjectSandboxes` alone: every declared remote, trust
 * first (an unconfirmed remote gets no ssh call), no local runner. Never throws
 * for one remote; its error string is `ssh <name>: ...`.
 */
export async function listRemoteSandboxes(deps: RemoteInventoryDeps): Promise<SandboxInventory> {
  const remotes = deps.remotes ?? {};
  if (Object.keys(remotes).length === 0) return { sandboxes: [], errors: [] };
  // In parallel, each bounded by `SSH_INVENTORY_TIMEOUT_MS`: one slow VM never stalls the rest.
  const listings = await Promise.all(Object.entries(remotes).map(([name, def]) => listRemote(name, def, deps)));
  return { sandboxes: listings.flatMap((l) => l.sandboxes), errors: listings.flatMap((l) => l.errors) };
}
