import type { RemoteDef } from '../../manifest/types.js';
import type { SshCore } from '../sandboxCores.js';
import { MIN_SANDBOX_GIT, checkSandboxGit } from '../sbx/sbxGitVersion.js';
import { sshArgv, sshDest, type SshProcess, type SshResult } from './sshProcess.js';
import { sshQuote } from './sshQuote.js';

/**
 * The remote preflight (D554, Part B). ONE bounded remote script gathers every
 * fact; a failure stops the use of the remote, a warning does not.
 *
 * The caller checks `isRemoteTrusted` before calling this (the trust record is
 * host state, not a remote fact), so this module never imports it. Karst never
 * writes the remote `known_hosts`: an unknown host key is a failed preflight
 * that tells the user to accept the key once themselves.
 *
 * The seam's option set is `StrictHostKeyChecking=yes` + `BatchMode=yes`, so a
 * new host fails instead of prompting, and the stderr of exit 255 is the only
 * place ssh reports it.
 *
 * The script's stdout is untrusted input: every value is validated here (the
 * booleans are exactly `yes`, the ids and sizes are decimal digits, the mode is
 * octal), and a fact the remote did not report fails closed.
 */

/** Lowest remote node the core CLIs support on a bare `node` (the image uses 22). */
export const MIN_REMOTE_NODE = '18';
/** Below this the remote cannot hold a clone plus bundles. */
export const MIN_REMOTE_FREE_MB = 2048;
/** Below this the remote works today but a sweep or a build can fill it. */
export const WARN_REMOTE_FREE_MB = 10240;
/** The whole preflight, one ssh round trip, must not hang a launch. */
export const SSH_PREFLIGHT_TIMEOUT_MS = 30_000;
/** The script is a fixed set of facts; anything larger is a broken remote. */
const MAX_PREFLIGHT_STDOUT_BYTES = 64 * 1024;

export interface SshPreflightOptions {
  /** The ControlMaster socket directory (Part A.2), checked by the seam's callers. */
  readonly controlDir: string;
  /**
   * The session core; `mode: direct` probes that name on the remote `PATH`
   * (`command -v <core>` plus `<core> --version`). The host's
   * `karst.opencode2.binaryPath` is host state: a remote direct install
   * provides its own command.
   */
  readonly core: SshCore;
  /** Test hook: the 30 s bound, so a fake can prove it without a real wait. */
  readonly timeoutMs?: number;
}

export interface SshPreflightFacts {
  readonly os: string;
  readonly uid: number;
  readonly gid: number;
  /** `major.minor[.patch]` from `git --version`. */
  readonly git: string;
  readonly setsid: boolean;
  readonly setsidW: boolean;
  readonly tmux: boolean;
  /** `major.minor[.patch]` from `node --version`, without the `v`. */
  readonly node: string;
  /** Real directory, no symlink, owned by the remote user, not group/world-writable. */
  readonly remoteDirOk: boolean;
  /** `AllowTcpForwarding` from `sshd -T`, else `unknown` (D823). */
  readonly allowTcpForwarding: string;
  /** Free MB in `remoteDir`; `null` when `df` was unreadable (then a warning). */
  readonly freeMb: number | null;
  /** `mode: docker` only: the server version. */
  readonly docker?: string;
  /** `mode: direct` only: the resolved core binary. */
  readonly coreBin?: string;
  /** `mode: direct` only: the first line of `<core> --version`. */
  readonly coreVersion?: string;
}

export type SshPreflightResult =
  | { readonly ok: true; readonly facts: SshPreflightFacts; readonly warnings: string[] }
  | { readonly ok: false; readonly reason: string };

/**
 * The remote facts as `key=value` lines. Every probe is quoted and tolerant of
 * a missing tool: the point is to report what is absent, not to fail the whole
 * script (which would tell us nothing). `sh` is the shell sshd runs it under
 * (`remoteSh`), never the user's login shell.
 */
function preflightScript(remote: RemoteDef, core: SshCore): string {
  const lines = [
    '# karst-ssh-preflight',
    `dir=${sshQuote(remote.remoteDir)}`,
    'mkdir -p -m 0700 -- "$dir" 2>/dev/null',
    `printf 'os=%s\\n' "$(uname -s 2>/dev/null)"`,
    `printf 'uid=%s\\n' "$(id -u 2>/dev/null)"`,
    `printf 'gid=%s\\n' "$(id -g 2>/dev/null)"`,
    `printf 'git=%s\\n' "$(git --version 2>/dev/null)"`,
    `if command -v setsid >/dev/null 2>&1; then printf 'setsid=yes\\n'; else printf 'setsid=no\\n'; fi`,
    `if setsid -w true >/dev/null 2>&1; then printf 'setsidW=yes\\n'; else printf 'setsidW=no\\n'; fi`,
    `if command -v tmux >/dev/null 2>&1; then printf 'tmux=yes\\n'; else printf 'tmux=no\\n'; fi`,
    `printf 'node=%s\\n' "$(node --version 2>/dev/null)"`,
    // A real directory only: a symlink could point anywhere, and another user
    // could have made it first to plant files. `stat -c` is Linux's spelling.
    `if [ -d "$dir" ] && [ ! -L "$dir" ]; then ` +
      `printf 'remoteDirStat=%s\\n' "$(stat -c '%u %a' -- "$dir" 2>/dev/null)"; else printf 'remoteDirStat=\\n'; fi`,
    // `sshd -T` prints the effective config when the user may read it; an
    // unreadable one is `unknown`, never a guess.
    `printf 'allowTcpForwarding=%s\\n' "$(sshd -T 2>/dev/null | sed -n 's/^allowtcpforwarding //p' | head -n 1)"`,
    `printf 'freeMb=%s\\n' "$(df -Pk -- "$dir" 2>/dev/null | awk 'NR == 2 { print $4 }')"`,
  ];
  if (remote.mode === 'docker') {
    lines.push(
      // `docker version` talks to the daemon; the shell reports a missing
      // binary as 127, which the host maps to its own reason.
      `dockerOut=$(docker version --format '{{.Server.Version}}' 2>/dev/null); dockerExit=$?`,
      `printf 'docker=%s\\n' "$dockerOut"`,
      `printf 'dockerExit=%s\\n' "$dockerExit"`,
    );
  } else {
    const bin = sshQuote(core);
    lines.push(
      `coreBin=$(command -v ${bin} 2>/dev/null)`,
      `printf 'coreBin=%s\\n' "$coreBin"`,
      `if [ -n "$coreBin" ]; then printf 'coreVersion=%s\\n' "$("$coreBin" --version 2>/dev/null | head -n 1)"; else printf 'coreVersion=\\n'; fi`,
    );
  }
  return lines.join('\n');
}

interface Version {
  readonly major: number;
  readonly minor: number;
  readonly patch?: number;
}

const GIT_VERSION = /git version (\d+)\.(\d+)(?:\.(\d+))?/;
const NODE_VERSION = /^v?(\d+)\.(\d+)(?:\.(\d+))?/;

function versionFrom(pattern: RegExp, text: string): Version | null {
  const match = pattern.exec(text);
  if (match === null) return null;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  if (!Number.isInteger(major) || !Number.isInteger(minor)) return null;
  return { major, minor, ...(match[3] === undefined ? {} : { patch: Number(match[3]) }) };
}

function versionText(version: Version): string {
  const base = `${String(version.major)}.${String(version.minor)}`;
  return version.patch === undefined ? base : `${base}.${String(version.patch)}`;
}

function majorMinor(version: Version): string {
  return `${String(version.major)}.${String(version.minor)}`;
}

/** Numeric major/minor compare: `9` is NOT greater than `18`. */
function versionAtLeast(version: Version, minMajor: number, minMinor: number): boolean {
  return version.major > minMajor || (version.major === minMajor && version.minor >= minMinor);
}

function decimalOrNull(value: string): number | null {
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/**
 * `stat -c '%u %a'`: owner must be the remote user, and neither the group nor
 * the other digit may carry the write bit (2). A 4-digit mode keeps its
 * leading bit in the parse, which only makes the check stricter on setuid.
 */
function remoteDirIsPrivate(statLine: string, uid: number): boolean {
  const parts = statLine.trim().split(/\s+/).filter((part) => part !== '');
  if (parts.length !== 2) return false;
  const owner = parts[0]!;
  const mode = parts[1]!;
  if (!/^\d+$/.test(owner) || !/^[0-7]{1,4}$/.test(mode)) return false;
  if (Number.parseInt(owner, 10) !== uid) return false;
  return (Number.parseInt(mode, 8) & 0o022) === 0;
}

/** The last non-empty stderr line, capped: ssh puts the cause at the end. */
function tail(stderr: string): string {
  const trimmed = stderr.trim();
  if (trimmed === '') return '';
  return (trimmed.split('\n').at(-1) ?? '').slice(0, 200);
}

/** Parse the script's `key=value` lines; a later duplicate never overrides the first. */
function parseKeyValues(stdout: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const raw of stdout.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    const separator = line.indexOf('=');
    if (separator <= 0) continue;
    const key = line.slice(0, separator);
    if (!/^[A-Za-z][A-Za-z0-9]*$/.test(key) || values.has(key)) continue;
    // The seam already caps stdout at MAX_PREFLIGHT_STDOUT_BYTES.
    values.set(key, line.slice(separator + 1));
  }
  return values;
}

/** Every failure names the remote and the step, prefixed `ssh <name>:`. */
function failed(name: string, detail: string): SshPreflightResult {
  return { ok: false, reason: `ssh ${name}: ${detail}` };
}

/** Exit 255 is a transport failure unless it is the host-key check talking. */
function transportFailed(name: string, remote: RemoteDef, stderr: string): SshPreflightResult {
  if (/Host key verification failed/.test(stderr) || /No .+ host key is known/.test(stderr)) {
    return failed(
      name,
      `host key not trusted (run ssh ${sshDest(remote)} once and accept the key)`,
    );
  }
  const detail = tail(stderr);
  return failed(name, detail === '' ? 'ssh transport failed' : `ssh transport failed: ${detail}`);
}

function interpret(name: string, remote: RemoteDef, core: SshCore, result: SshResult): SshPreflightResult {
  if (result.transport === true) return transportFailed(name, remote, result.stderr);
  if (result.code === 127) return failed(name, 'ssh not found (install openssh-client)');
  if (result.code !== 0) {
    const detail = tail(result.stderr);
    return failed(
      name,
      detail === '' ? `preflight failed (exit ${String(result.code)})` : `preflight failed (exit ${String(result.code)}): ${detail}`,
    );
  }

  const values = parseKeyValues(result.stdout);
  const raw = (key: string): string => values.get(key)?.trim() ?? '';

  const os = raw('os');
  if (os !== 'Linux') return failed(name, `remote OS ${os === '' ? 'unknown' : os} not supported`);

  const uid = decimalOrNull(raw('uid'));
  if (uid === null) return failed(name, 'preflight did not report a uid');
  const gid = decimalOrNull(raw('gid'));
  if (gid === null) return failed(name, 'preflight did not report a gid');

  const gitRaw = raw('git');
  if (gitRaw === '') return failed(name, 'git not found');
  const git = versionFrom(GIT_VERSION, gitRaw);
  if (git === null) return failed(name, `git version unreadable (${gitRaw.slice(0, 200)})`);
  if (!checkSandboxGit(gitRaw).ok) return failed(name, `git ${majorMinor(git)} < ${MIN_SANDBOX_GIT}`);

  const setsid = raw('setsid') === 'yes';
  if (!setsid) return failed(name, 'setsid not found (install util-linux)');
  const setsidW = raw('setsidW') === 'yes';
  if (!setsidW) return failed(name, 'setsid has no -w (util-linux too old)');

  const nodeRaw = raw('node');
  if (nodeRaw === '') return failed(name, 'node not found');
  const node = versionFrom(NODE_VERSION, nodeRaw);
  if (node === null) return failed(name, `node version unreadable (${nodeRaw.slice(0, 200)})`);
  const [minNodeMajor = 0, minNodeMinor = 0] = MIN_REMOTE_NODE.split('.').map((part) => Number.parseInt(part, 10));
  if (!versionAtLeast(node, minNodeMajor, minNodeMinor)) {
    return failed(name, `node ${majorMinor(node)} < ${MIN_REMOTE_NODE}`);
  }

  const remoteDirOk = remoteDirIsPrivate(raw('remoteDirStat'), uid);
  if (!remoteDirOk) return failed(name, `remoteDir ${remote.remoteDir} is not private`);

  const tmux = raw('tmux') === 'yes';
  const warnings: string[] = [];
  if (!tmux) warnings.push(`ssh ${name}: tmux not found; the agent stops when the connection drops (install tmux)`);

  const freeMb = decimalOrNull(raw('freeMb'));
  if (freeMb === null) {
    // Never a silent pass: an unreadable df could be a full disk.
    warnings.push(`ssh ${name}: cannot read free disk in ${remote.remoteDir}`);
  } else if (freeMb < MIN_REMOTE_FREE_MB) {
    return failed(name, `${String(freeMb)} MB free in ${remote.remoteDir}, need ${String(MIN_REMOTE_FREE_MB)} MB`);
  } else if (freeMb < WARN_REMOTE_FREE_MB) {
    warnings.push(`ssh ${name}: low disk (${String(freeMb)} MB free in ${remote.remoteDir})`);
  }

  const forwardingRaw = raw('allowTcpForwarding');
  const allowTcpForwarding = /^[A-Za-z]+$/.test(forwardingRaw) ? forwardingRaw : 'unknown';

  const common = {
    os,
    uid,
    gid,
    git: versionText(git),
    setsid,
    setsidW,
    tmux,
    node: versionText(node),
    remoteDirOk,
    allowTcpForwarding,
    freeMb,
  };

  if (remote.mode === 'docker') {
    const docker = raw('docker');
    if (docker === '') {
      return raw('dockerExit') === '127'
        ? failed(name, 'docker not found')
        : failed(name, 'docker daemon not reachable');
    }
    return { ok: true, facts: { ...common, docker }, warnings };
  }

  const coreBin = raw('coreBin');
  if (coreBin === '') return failed(name, `${core} not found`);
  const coreVersion = raw('coreVersion');
  if (coreVersion === '') return failed(name, `${core} --version failed`);
  return { ok: true, facts: { ...common, coreBin, coreVersion }, warnings };
}

/**
 * Gather the remote facts in ONE ssh round trip, bounded at 30 s. Async, so it
 * never blocks the extension host; the abort signal kills the one child. The
 * caller has already confirmed the remote is trusted.
 */
export async function sshPreflight(
  name: string,
  remote: RemoteDef,
  proc: SshProcess,
  opts: SshPreflightOptions,
): Promise<SshPreflightResult> {
  const argv = sshArgv(remote, opts.controlDir, preflightScript(remote, opts.core));
  const timeoutMs = opts.timeoutMs ?? SSH_PREFLIGHT_TIMEOUT_MS;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<{ readonly kind: 'timeout' }>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve({ kind: 'timeout' });
    }, timeoutMs);
    timer.unref();
  });
  const pending = proc.run(argv, { signal: controller.signal, maxStdoutBytes: MAX_PREFLIGHT_STDOUT_BYTES }).then(
    (result) => ({ kind: 'result' as const, result }),
    (err: unknown) => ({ kind: 'error' as const, err }),
  );
  try {
    const raced = await Promise.race([pending, timedOut]);
    if (raced.kind === 'timeout') return failed(name, 'preflight timed out');
    if (raced.kind === 'error') {
      return failed(name, `preflight failed: ${raced.err instanceof Error ? raced.err.message : String(raced.err)}`);
    }
    return interpret(name, remote, opts.core, raced.result);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
