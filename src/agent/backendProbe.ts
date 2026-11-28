import type { RemoteDef } from '../manifest/types.js';
import { parseDockerSize } from '../doctor/sandboxChecks.js';
import type { BackendWant } from './backendChoices.js';
import type { BackendStatus } from './effectiveBackend.js';
import { sbxPreflight } from './sbx/sbxPreflight.js';
import { NODE_SBX_PROCESS, type SbxProcess } from './sbx/sbxProcess.js';
import { OPENCODE_IMAGE_REPOSITORY } from './docker/dockerImage.js';
import { dockerPreflight } from './docker/dockerPreflight.js';
import { DOCKER_ASSETS_DIR } from './docker/resolveDocker.js';
import { NODE_DOCKER_PROCESS } from './docker/dockerProcess.js';
import { isRemoteTrusted, readRemoteTrust } from './ssh/remoteTrust.js';
import { remoteDirIsSafe } from './ssh/sshDisposeGuard.js';
import { SANDBOX_NAME_RE, sshProjectPrefix } from './ssh/sshNames.js';
import { sshArgv, type SshProcess, type SshResult } from './ssh/sshProcess.js';
import { sshQuote } from './ssh/sshQuote.js';

export interface BackendProbes {
  readonly sbx: BackendStatus;
  readonly docker: BackendStatus;
}

/**
 * Readiness of the wanted sandbox backends (the rest are skipped and read `not selected`), via the same preflights `resolveBackend`
 * runs (arch:AC-31), so the status the UI shows is the decision a session start
 * would make. Never throws.
 */
export async function probeBackends(want: BackendWant = { sbx: true, docker: true, ssh: false }, debug: (msg: string) => void = () => {}): Promise<BackendProbes> {
  const [sbx, docker] = await Promise.all([
    want.sbx ? sbxPreflight(NODE_SBX_PROCESS) : NOT_SELECTED,
    want.docker ? dockerPreflight(NODE_DOCKER_PROCESS, DOCKER_ASSETS_DIR, debug) : NOT_SELECTED,
  ]);
  return { sbx: toStatus(sbx), docker: toStatus(docker) };
}

const NOT_SELECTED = { ok: false, reason: 'not selected' } as const;

function toStatus(p: { readonly ok: true } | { readonly ok: false; readonly reason: string }): BackendStatus {
  return p.ok ? { ok: true } : { ok: false, reason: p.reason };
}

/** Approximate bytes used by karst docker containers (`docker ps -a --size`); undefined when it cannot be read. */
export async function probeDockerDisk(proc: SbxProcess = NODE_DOCKER_PROCESS): Promise<number | undefined> {
  try {
    const r = await proc.run('docker', ['ps', '-a', '--size', '--filter', 'name=karst-', '--format', '{{.Size}}']);
    if (r.code !== 0) return undefined;
    let total = 0;
    for (const line of r.stdout.split('\n').filter((l) => l.trim() !== '')) {
      const n = parseDockerSize(line);
      if (n === undefined) return undefined;
      total += n;
    }
    return total;
  } catch {
    return undefined;
  }
}

/** Bytes of karst sandbox images (repository `karst/opencode-sandbox`) and of the whole build cache; each undefined when unreadable. */
export async function probeDockerImageDisk(proc: SbxProcess = NODE_DOCKER_PROCESS): Promise<{ readonly imageBytes: number | undefined; readonly cacheBytes: number | undefined }> {
  const sum = async (args: string[], pick: (line: string) => string | undefined): Promise<number | undefined> => {
    try {
      const r = await proc.run('docker', args);
      if (r.code !== 0) return undefined;
      let total = 0;
      for (const line of r.stdout.split('\n').filter((l) => l.trim() !== '')) {
        const cell = pick(line);
        const n = cell === undefined ? undefined : parseDockerSize(cell);
        if (n === undefined) return undefined;
        total += n;
      }
      return total;
    } catch {
      return undefined;
    }
  };
  const [imageBytes, cacheBytes] = await Promise.all([
    sum(['image', 'ls', OPENCODE_IMAGE_REPOSITORY, '--format', '{{.Size}}'], (l) => l),
    sum(['system', 'df', '--format', '{{.Type}}|{{.Size}}'], (l) => (l.startsWith('Build Cache|') ? l.slice('Build Cache|'.length) : '0B')),
  ]);
  return { imageBytes, cacheBytes };
}

/** The Docker VM's total memory in bytes (`docker info` MemTotal); undefined when it cannot be read. */
export async function probeDockerMemory(proc: SbxProcess = NODE_DOCKER_PROCESS): Promise<number | undefined> {
  try {
    const r = await proc.run('docker', ['info', '--format', '{{.MemTotal}}']);
    const n = Number(r.stdout.trim());
    return r.code === 0 && Number.isFinite(n) && n > 0 ? n : undefined;
  } catch {
    return undefined;
  }
}

/** The doctor's remote probes are one ssh round trip each; a hung VM never holds `karst doctor`. */
export const REMOTE_PROBE_TIMEOUT_MS = 20_000;

/** What a remote disk probe needs: the same identity the inventory hashes, and the trust record. */
export interface RemoteProbeContext {
  /** The project-root string the ssh names hash (the manifest path, as the launch uses it). */
  readonly projectRoot: string;
  /** `<globalStorage>/ssh/install-id`; a host step never creates it (D826). */
  readonly installId: string;
  /** The dir of `ssh-trust.json` (D553 C1). */
  readonly trustDir: string;
  /** The checked ControlMaster dir (D554). */
  readonly controlDir: string;
  /** Clock for a workspace's age (tests pin it). */
  readonly now?: number;
}

/** A trusted remote's disk use: this install's workspaces only, and the free disk. */
export interface RemoteDiskFacts {
  readonly workspaces: number;
  readonly usedKb: number | undefined;
  readonly freeKb: number | undefined;
}

/** One prefix workspace with the age of its last launch and its `du -sk` size. */
export interface RemoteWorkspaceProbe {
  readonly name: string;
  readonly ageDays: number;
  readonly sizeKb: number;
}

export interface RemoteProbeError {
  readonly error: string;
}

const INSTALL_ID_RE = /^[0-9a-f]{32}$/;
/** The prefix embedded unquoted in a remote glob, so it must be exactly this shape. */
const PREFIX_RE = /^karst-[0-9a-f]{8}$/;

function probeError(name: string, detail: string): RemoteProbeError {
  return { error: `ssh ${name}: ${detail}` };
}

function tail(text: string): string {
  const line = text.trim().split('\n').filter((l) => l.trim() !== '').at(-1);
  return line === undefined ? '' : line.slice(0, 300);
}

/** Trust first (D553 C1) and the same prefix the inventory uses; `undefined` is the reason it cannot run. */
function remoteProbePrefix(name: string, def: RemoteDef, ctx: RemoteProbeContext): { readonly prefix: string; readonly dir: string } | RemoteProbeError {
  if (!isRemoteTrusted(readRemoteTrust(ctx.trustDir), name, def)) {
    return probeError(name, `ssh remote ${name} not confirmed`);
  }
  if (!remoteDirIsSafe(def.remoteDir)) {
    return probeError(name, `refused remoteDir ${JSON.stringify(def.remoteDir)}`);
  }
  if (!INSTALL_ID_RE.test(ctx.installId)) return probeError(name, 'install id missing');
  const prefix = sshProjectPrefix(ctx.projectRoot, ctx.installId);
  if (!PREFIX_RE.test(prefix)) return probeError(name, 'install id missing');
  return { prefix, dir: def.remoteDir.replace(/\/+$/, '') };
}

async function runProbe(ssh: SshProcess, name: string, def: RemoteDef, ctx: RemoteProbeContext, script: string): Promise<SshResult | RemoteProbeError> {
  try {
    const out = await ssh.run(sshArgv(def, ctx.controlDir, script), {
      maxStdoutBytes: 256 * 1024,
      signal: AbortSignal.timeout(REMOTE_PROBE_TIMEOUT_MS),
    });
    if (out.transport === true) return probeError(name, `transport failed: ${tail(out.stderr)}`);
    if (out.code !== 0) return probeError(name, `probe failed (exit ${String(out.code)})${tail(out.stderr) === '' ? '' : `: ${tail(out.stderr)}`}`);
    return out;
  } catch (err) {
    return probeError(name, `probe failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** `du -sk` over THIS install's workspaces only, plus the free disk; `grep -c .` counts dirs. */
function remoteDiskScript(dir: string, prefix: string): string {
  return [
    '# karst-ssh-remote-disk',
    `d=${sshQuote(dir)}`,
    `rows=$(ls -1d "$d"/${prefix}-* 2>/dev/null | while IFS= read -r x; do [ -d "$x" ] || continue; du -sk "$x" 2>/dev/null; done)`,
    `printf 'count=%s\\n' "$(printf '%s\\n' "$rows" | grep -c .)"`,
    `printf 'usedKb=%s\\n' "$(printf '%s\\n' "$rows" | awk '{s+=$1} END {print s+0}')"`,
    `printf 'freeKb=%s\\n' "$(df -Pk -- "$d" 2>/dev/null | awk 'NR == 2 { print $4 }')"`,
    'exit 0',
  ].join('\n');
}

function intOrUndefined(text: string | undefined): number | undefined {
  if (text === undefined || !/^\d+$/.test(text.trim())) return undefined;
  const n = Number.parseInt(text.trim(), 10);
  return Number.isSafeInteger(n) ? n : undefined;
}

/** The script's `count=`, `usedKb=` and `freeKb=` lines; an unparsable line is undefined, never 0. */
export function parseRemoteDisk(stdout: string): RemoteDiskFacts {
  const values = new Map<string, string>();
  for (const raw of stdout.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    const at = line.indexOf('=');
    if (at <= 0) continue;
    const key = line.slice(0, at);
    if (!values.has(key)) values.set(key, line.slice(at + 1));
  }
  return {
    workspaces: intOrUndefined(values.get('count')) ?? 0,
    usedKb: intOrUndefined(values.get('usedKb')),
    freeKb: intOrUndefined(values.get('freeKb')),
  };
}

/** The age is the mtime of `env/env.sh` (the last launch), falling back to the dir for a half-made one. */
function remoteWorkspaceAgeScript(dir: string, prefix: string): string {
  return [
    '# karst-ssh-remote-workspaces',
    `d=${sshQuote(dir)}`,
    `for x in "$d"/${prefix}-*; do`,
    '  [ -d "$x" ] || continue',
    '  n=${x##*/}',
    `  m=$(stat -c %Y "$x/env/env.sh" 2>/dev/null || stat -c %Y "$x" 2>/dev/null || printf '0')`,
    `  k=$(du -sk "$x" 2>/dev/null | awk 'NR == 1 { print $1 }')`,
    `  printf '%s\\t%s\\t%s\\n' "$n" "$m" "\${k:-0}"`,
    'done',
    'exit 0',
  ].join('\n');
}

/** `name\tmtime\tkb` lines; a name outside this install's prefix or the sandbox shape is skipped. */
export function parseRemoteWorkspaceAges(stdout: string, nowMs: number, prefix: string): RemoteWorkspaceProbe[] {
  const prefixWithDash = `${prefix}-`;
  const out: RemoteWorkspaceProbe[] = [];
  for (const raw of stdout.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (line.trim() === '') continue;
    const [name, mtime, kb] = line.split('\t');
    if (name === undefined || !name.startsWith(prefixWithDash) || !SANDBOX_NAME_RE.test(name)) continue;
    const seconds = intOrUndefined(mtime);
    const sizeKb = intOrUndefined(kb);
    if (seconds === undefined || sizeKb === undefined) continue;
    out.push({ name, ageDays: Math.max(0, Math.floor((nowMs / 1000 - seconds) / 86_400)), sizeKb });
  }
  return out;
}

/** A trusted remote's disk facts, or the reason it could not be read (no ssh for an unconfirmed remote). */
export async function probeRemoteDisk(ssh: SshProcess, name: string, def: RemoteDef, ctx: RemoteProbeContext): Promise<RemoteDiskFacts | RemoteProbeError> {
  const target = remoteProbePrefix(name, def, ctx);
  if ('error' in target) return target;
  const out = await runProbe(ssh, name, def, ctx, remoteDiskScript(target.dir, target.prefix));
  if ('error' in out) return out;
  return parseRemoteDisk(out.stdout);
}

/** This install's prefix workspaces on a trusted remote with their launch age and size; no ssh when unconfirmed. */
export async function probeRemoteWorkspaces(ssh: SshProcess, name: string, def: RemoteDef, ctx: RemoteProbeContext): Promise<readonly RemoteWorkspaceProbe[] | RemoteProbeError> {
  const target = remoteProbePrefix(name, def, ctx);
  if ('error' in target) return target;
  const out = await runProbe(ssh, name, def, ctx, remoteWorkspaceAgeScript(target.dir, target.prefix));
  if ('error' in out) return out;
  return parseRemoteWorkspaceAges(out.stdout, ctx.now ?? Date.now(), target.prefix);
}

/** "Docker VM 4.8 GB, 2 other karst/playwright containers running" for a killed setup's reason; undefined when nothing is readable. */
export async function dockerKillContext(proc: SbxProcess = NODE_DOCKER_PROCESS): Promise<string | undefined> {
  const mem = await probeDockerMemory(proc);
  let others: number | undefined;
  try {
    const r = await proc.run('docker', ['ps', '--format', '{{.Names}} {{.Image}}']);
    if (r.code === 0) others = r.stdout.split('\n').filter((l) => /karst-|playwright/i.test(l)).length;
  } catch {
    others = undefined;
  }
  const parts = [
    mem === undefined ? undefined : `Docker VM ${(mem / 2 ** 30).toFixed(1)} GB`,
    others === undefined ? undefined : `${others} karst/playwright container${others === 1 ? '' : 's'} running`,
  ].filter((x): x is string => x !== undefined);
  return parts.length ? parts.join(', ') : undefined;
}
