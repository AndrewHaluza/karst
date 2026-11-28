import { access } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { RemoteDef } from '../../manifest/types.js';
import { accountLaunchFor } from '../accounts/registry.js';
import { dockerNames } from '../docker/dockerNames.js';
import { OPENCODE_IMAGE } from '../docker/dockerImage.js';
import { queryDockerMemTotal, resolveDockerMemoryLimits, type SandboxMemoryConfig } from '../docker/dockerMemory.js';
import { dockerPreflight, REMOTE_BUILD_TIMEOUT_MS } from '../docker/dockerPreflight.js';
import { prepareDockerSandbox } from '../docker/dockerRunner.js';
import { stopProxySidecar } from '../docker/proxySidecar.js';
import { DOCKER_ASSETS_DIR, linuxUser } from '../docker/resolveDocker.js';
import { opencode2Command, opencode2Config, opencode2IsolationEnv } from '../opencode2Binary.js';
import { OPENCODE2_AUTH_LIST_ARGS, opencode2HasCredentials } from '../opencode2Auth.js';
import { NODE_SBX_PROCESS, type SbxProcess } from '../sbx/sbxProcess.js';
import { SSH_CORES, SSH_DOCKER_CORES, type SshCore, type SshDockerCore } from '../sandboxCores.js';
import type { SandboxTicketRef, SessionRunner } from '../sessionRunner.js';
import { PROXY_BUNDLE, ensureRemoteDockerAssets } from './sshDockerAssets.js';
import { ensureSshClone, sshRemotePaths, type SshCloneContext } from './sshClone.js';
import { ensureSshDockerClone, type SshDockerCloneContext } from './sshDockerClone.js';
import { ensureSshControlDir, sshControlDir } from './sshControlDir.js';
import { probeSshDockerEgress } from './sshDockerEgress.js';
import { SSH_DOCKER_HOST_SERVICES_ERROR, createSshDockerSessionRunner, sshDockerMountRoot } from './sshDockerRunner.js';
import { sshDockerProcess } from './sshDockerProcess.js';
import type { SshGateRegistry } from './sshGateRegistry.js';
import { sshProjectPrefix, sshSandboxName } from './sshNames.js';
import { sshPreflight, noTmuxWarning, type SshPreflightOptions, type SshPreflightResult } from './sshPreflight.js';
import { NODE_SSH_PROCESS, SSH_BIN, sshArgv, type SshProcess } from './sshProcess.js';
import { sshQuote } from './sshQuote.js';
import { createSshSessionRunner } from './sshRunner.js';
import { ensureRemoteWorkspaceTrusted, type RemoteTrustInput } from './sshTrust.js';

/**
 * Resolve the `ssh:<name>` backend for one launch (D555 edit 7, D822 docker).
 * The trust check is first and makes no ssh call; then the remote lookup and the
 * mode:
 *
 * - `mode: direct`: the preflight, the core login, the names, the clone and the
 *   workspace trust, in that order (a prompted session on the remote).
 * - `mode: docker`: `resolveDockerSteps` — the core and the declared host ports
 *   are refused before any ssh call, then the remote facts, the verified asset
 *   upload, the image, the prepare and the egress probe, and only then a
 *   sandbox-enforcing runner.
 *
 * Every failure is a bare reason (the resolver adds `host (…)`), the whole step
 * is bounded, and this function never throws.
 */

/** The bound of the whole resolve step. */
export const SSH_RESOLVE_TIMEOUT_MS = 180_000;
/**
 * The resolve deadline while the remote image build runs: the build's own pipe
 * bound (`REMOTE_BUILD_TIMEOUT_MS`) plus a margin, so the build's failure is
 * what the launch reports instead of a generic "setup did not finish".
 */
export const SSH_DOCKER_BUILD_DEADLINE_MS = REMOTE_BUILD_TIMEOUT_MS + 60_000;
const SETUP_ABORTED = 'ssh: setup aborted after its deadline';
const LOGIN_STDOUT_BYTES = 16 * 1024;

/** The once-per-window state of the no-tmux warning (one set per extension window). */
export interface SshWarnOnce {
  readonly warned: Set<string>;
}

export const WINDOW_SSH_WARN_ONCE: SshWarnOnce = { warned: new Set<string>() };

export interface SshResolveDeps {
  readonly ssh?: SshProcess;
  readonly sshBin?: string;
  readonly host?: SbxProcess;
  /** The control dir and its private-dir check (the D554 seam). */
  readonly controlDir?: string;
  /** `<globalStorage>`: the dir of `ssh-trust.json`; the launch upload re-reads it (D553). */
  readonly trustDir?: string;
  readonly ensureControlDir?: (dir: string) => Promise<{ readonly ok: true } | { readonly ok: false; readonly reason: string }>;
  readonly preflight?: (name: string, remote: RemoteDef, proc: SshProcess, opts: SshPreflightOptions) => Promise<SshPreflightResult>;
  readonly clone?: typeof ensureSshClone;
  readonly trust?: (input: RemoteTrustInput) => Promise<void>;
  readonly registry?: SshGateRegistry;
  readonly timeoutMs?: number;
  readonly warnOnce?: SshWarnOnce;
  readonly warn?: (message: string) => void;
  readonly debug?: (message: string) => void;
  // `mode: docker` (D822). Every step is a seam so the unit tests drive the
  // whole resolve with fakes and no remote docker exists here.
  /** The host dir of the image build context and the uploaded proxy bundle. */
  readonly assetsDir?: string;
  readonly ensureAssets?: typeof ensureRemoteDockerAssets;
  readonly dockerPreflight?: typeof dockerPreflight;
  readonly prepareDocker?: typeof prepareDockerSandbox;
  readonly egressProbe?: typeof probeSshDockerEgress;
  /** The host opencode v1 `auth.json` of the launch account (parity with `resolveDocker`). */
  readonly hostAuthFile?: (account?: string) => Promise<string | undefined>;
  /** The host `opencode2 auth export` command and env of the launch account. */
  readonly opencode2Host?: (account?: string) => { readonly command: string; readonly env: Readonly<Record<string, string>> };
  /** Progress for a first (slow) remote image build, so the launch is not silent. */
  readonly onProgress?: (message: string) => void;
  /**
   * The CALLER's own bound (the launch guard): a step that names its longer
   * bound raises it too, so the guard does not kill a cold remote image build
   * while this resolve would have waited for it.
   */
  readonly extendDeadline?: (ms: number) => void;
}

export interface SshResolveInput {
  readonly remoteName: string;
  readonly remotes: Readonly<Record<string, RemoteDef>> | undefined;
  /** The host-side trust record (`ssh-trust.json`): checked before any ssh call. */
  readonly remoteTrusted: (name: string) => boolean;
  readonly core: string;
  readonly projectRoot: string;
  readonly installId: string;
  readonly ticketId: number;
  readonly worktree: SandboxTicketRef | undefined;
  /** The account of the launch (`mode: docker` copies its credentials into the container). */
  readonly account?: string;
  /** Declared baseline host ports: refused in `mode: docker` before any ssh call (D823). */
  readonly hostPorts?: readonly number[];
  /** The manifest's `sandboxMemory` overrides for the remote container limits. */
  readonly sandboxMemory?: SandboxMemoryConfig;
  readonly deps?: SshResolveDeps;
}

export interface SshNames {
  readonly remote: string;
  readonly name: string;
}

export type SshResolution =
  | { readonly ok: true; readonly runner: SessionRunner; readonly names: SshNames; readonly warnings: readonly string[] }
  | { readonly ok: false; readonly reason: string };

interface LoginCheck {
  readonly script: string;
  readonly signedIn: (stdout: string) => boolean;
  readonly fix: string;
}

/**
 * The remote sign-in signal of each core, the same files the host probe reads
 * (`signedInProbe.ts`); opencode2 uses `auth list` (never `auth export`). The
 * script prints only `yes`/`no` or the provider list, never a secret.
 */
function loginCheck(core: SshCore, coreBin: string): LoginCheck {
  const yes = (stdout: string): boolean => stdout.trim() === 'yes';
  switch (core) {
    case 'claude':
      return {
        script: `d="\${CLAUDE_CONFIG_DIR:-$HOME/.claude}"; if [ -f "$d/.credentials.json" ] || grep -q '"oauthAccount"' "$HOME/.claude.json" 2>/dev/null; then echo yes; else echo no; fi`,
        signedIn: yes,
        fix: 'claude (then /login)',
      };
    case 'codex':
      return { script: `if [ -f "\${CODEX_HOME:-$HOME/.codex}/auth.json" ]; then echo yes; else echo no; fi`, signedIn: yes, fix: 'codex login' };
    case 'opencode':
      return {
        script: `if [ -f "\${XDG_DATA_HOME:-$HOME/.local/share}/opencode/auth.json" ]; then echo yes; else echo no; fi`,
        signedIn: yes,
        fix: 'opencode auth login',
      };
    case 'opencode2':
      return {
        script: [coreBin, ...OPENCODE2_AUTH_LIST_ARGS].map(sshQuote).join(' ') + ' 2>/dev/null',
        signedIn: opencode2HasCredentials,
        fix: 'opencode2 auth login',
      };
  }
}

function isSshCore(core: string): core is SshCore {
  return (SSH_CORES as readonly string[]).includes(core);
}

function isSshDockerCore(core: string): core is SshDockerCore {
  return (SSH_DOCKER_CORES as readonly string[]).includes(core);
}

/**
 * The host opencode v1 `auth.json` of the launch account. Same rule as
 * `docker/resolveDocker.ts` (its helper is not exported): the launch account's
 * `XDG_DATA_HOME`, else the process one. Absent → the container is seeded
 * without a v1 credential (the core then asks for a login inside the sandbox).
 */
async function defaultHostAuthFile(account?: string): Promise<string | undefined> {
  // @arch:AC-55: the sign-in of the launch account, not the process one.
  const dataHome = accountLaunchFor('opencode', 'opencode', account).env.XDG_DATA_HOME || process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share');
  const file = join(dataHome, 'opencode', 'auth.json');
  try {
    await access(file);
    return file;
  } catch {
    return undefined;
  }
}

/** The host side of the opencode2 credential seed, under the account of the launch (@arch:AC-55). */
function defaultOpencode2Host(account?: string): { command: string; env: Record<string, string> } {
  const launch = accountLaunchFor('opencode2', opencode2Command(), account);
  return { command: launch.binary, env: { ...opencode2IsolationEnv(opencode2Config().home), ...launch.env } };
}

/**
 * `mode: docker` on an SSH remote (D822): the local docker backend against the
 * remote daemon. Order matters and mirrors the local resolve: refuse what can
 * never work FIRST (an unsupported core, declared host ports — zero ssh calls),
 * then the preflight facts, the verified asset upload, the verified image, the
 * prepare, and finally the egress probe. `enforcesSandbox: true` is only
 * reached when the probe proved the isolation on that daemon.
 */
async function resolveDockerSteps(
  input: SshResolveInput,
  name: string,
  remote: RemoteDef,
  deps: SshResolveDeps,
  signal: AbortSignal,
  extendBound: (ms: number) => void,
): Promise<SshResolution> {
  if (!isSshDockerCore(input.core)) {
    return { ok: false, reason: `${input.core}: ssh docker mode supports only opencode, opencode2` };
  }
  // D823: a baseline host port names THIS machine; on a remote daemon
  // `host-gateway` is the VM. Refused before a single ssh command runs.
  if (input.hostPorts !== undefined && input.hostPorts.length > 0) {
    return { ok: false, reason: SSH_DOCKER_HOST_SERVICES_ERROR };
  }
  const worktree = input.worktree;
  if (!worktree?.branch) return { ok: false, reason: 'ssh: ticket has no worktree branch to clone' };
  const ssh = deps.ssh ?? NODE_SSH_PROCESS;
  const sshBin = deps.sshBin ?? SSH_BIN;
  const controlDir = deps.controlDir ?? sshControlDir();
  const control = await (deps.ensureControlDir ?? ensureSshControlDir)(controlDir);
  if (!control.ok) return control;
  // The remote preflight already probes `docker version` in docker mode and
  // reports the REMOTE uid/gid the container must run as.
  const pre = await (deps.preflight ?? sshPreflight)(name, remote, ssh, { controlDir, core: input.core });
  if (!pre.ok) return pre;
  // The deadline may have fired while the preflight ran: nothing else may spawn.
  if (signal.aborted) return { ok: false, reason: SETUP_ABORTED };
  const user = linuxUser('linux', pre.facts.uid, pre.facts.gid);
  const names = dockerNames({ projectRoot: input.projectRoot, ticketId: input.ticketId, core: input.core, installId: input.installId });
  const mountRoot = sshDockerMountRoot(remote.remoteDir, names.container, input.ticketId);
  const dockerProc = sshDockerProcess(remote, ssh, { controlDir, sshBin });
  const assetsDir = deps.assetsDir ?? DOCKER_ASSETS_DIR;
  const assets = await (deps.ensureAssets ?? ensureRemoteDockerAssets)({
    ssh, sshBin, remote, remoteName: name, controlDir, hostAssetsDir: assetsDir,
    ...(deps.debug ? { debug: deps.debug } : {}),
  });
  if (!assets.ok) return assets;
  // An upload can outlive the deadline too: never start a tar/build for a launch that gave up.
  if (signal.aborted) return { ok: false, reason: SETUP_ABORTED };
  // A remote build streams the tar context over stdin (`proc.pipe`): the remote
  // daemon can see neither the host context dir nor the host tar. The first
  // build names its OWN bound (the preflight's pipe); the resolve deadline is
  // raised to it here, so the 180 s race cannot fire mid-build, and the signal
  // kills the build if the raised deadline is reached too.
  const check = await (deps.dockerPreflight ?? dockerPreflight)(dockerProc, assetsDir, deps.debug, {
    streamContext: true,
    onProgress: (message) => {
      // The build names its own bound for BOTH deadlines: this resolve's and the caller's guard,
      // which would otherwise kill a healthy cold build at its generic timeout.
      extendBound(SSH_DOCKER_BUILD_DEADLINE_MS);
      deps.extendDeadline?.(SSH_DOCKER_BUILD_DEADLINE_MS);
      deps.onProgress?.(message);
    },
    signal,
  });
  if (!check.ok) return check;
  if (signal.aborted) return { ok: false, reason: SETUP_ABORTED };
  const memory = resolveDockerMemoryLimits(await queryDockerMemTotal(dockerProc), input.sandboxMemory);
  const hostAuthFile = input.core === 'opencode' ? await (deps.hostAuthFile ?? defaultHostAuthFile)(input.account) : undefined;
  const opencode2Host = input.core === 'opencode2' ? (deps.opencode2Host ?? defaultOpencode2Host)(input.account) : undefined;
  const cloneCtx: SshDockerCloneContext = {
    ssh, sshBin, host: deps.host ?? NODE_SBX_PROCESS, remote, remoteName: name, controlDir,
    image: OPENCODE_IMAGE, volume: names.repoVolume, user, ...(deps.debug ? { debug: deps.debug } : {}),
  };
  const prepared = await (deps.prepareDocker ?? prepareDockerSandbox)({
    proc: dockerProc, core: input.core, names, user, ticket: worktree,
    proxyScript: `${mountRoot.assetsDir}/${PROXY_BUNDLE}`,
    mountRoot,
    // D554: host git stays local and only bundles cross the ssh pipe. A host
    // temp dir bind mount would point at nothing on the remote daemon.
    seedClone: (t: SandboxTicketRef) => ensureSshDockerClone(cloneCtx, {
      hostWorktreePath: t.hostWorktreePath, branch: t.branch, ...(t.baseRef ? { baseRef: t.baseRef } : {}),
    }),
    ...(hostAuthFile !== undefined ? { opencode1HostAuthFile: hostAuthFile } : {}),
    ...(opencode2Host !== undefined ? { opencode2Host } : {}),
    ...(deps.debug ? { debug: deps.debug } : {}),
  });
  if (!prepared.ok) return prepared;
  if (signal.aborted) {
    // The launch already gave up: the proxy `prepare` started is the one object with egress.
    await stopProxySidecar(dockerProc, names.proxy);
    return { ok: false, reason: SETUP_ABORTED };
  }
  // @arch:AC-53 (d): measured on the remote daemon, not assumed from the image.
  const egress = await (deps.egressProbe ?? probeSshDockerEgress)(dockerProc, names, user, deps.debug);
  if (signal.aborted) {
    // The deadline fired while the probe ran: the runner is discarded, and the proxy is the
    // one container with egress — it must not stay up for a ticket that runs on the host.
    await stopProxySidecar(dockerProc, names.proxy);
    return { ok: false, reason: SETUP_ABORTED };
  }
  if (!egress.ok) {
    // Never leave the one object with egress up for a ticket that falls back.
    await stopProxySidecar(dockerProc, names.proxy);
    return { ok: false, reason: `ssh docker egress not enforced: ${egress.reason}` };
  }
  const runner = createSshDockerSessionRunner({
    ssh, sshBin, host: cloneCtx.host, remote, remoteName: name, controlDir, core: input.core,
    ticketId: input.ticketId, names, user, hostWorktreePath: worktree.hostWorktreePath,
    projectPrefix: sshProjectPrefix(input.projectRoot, input.installId), memory,
    ...(deps.trustDir !== undefined ? { trustDir: deps.trustDir } : {}),
    ...(deps.debug ? { debug: deps.debug } : {}),
  });
  // tmux carries the direct session only: a docker launch is `ssh -t … docker run -it`, so a
  // remote without tmux must not warn about it (the free-disk warnings still apply).
  const warnings = pre.warnings.filter((warning) => warning !== noTmuxWarning(name));
  return { ok: true, runner, names: { remote: name, name: names.container }, warnings };
}

async function checkLogin(ssh: SshProcess, remote: RemoteDef, controlDir: string, name: string, core: SshCore, coreBin: string): Promise<string | undefined> {
  const check = loginCheck(core, coreBin);
  const out = await ssh.run(sshArgv(remote, controlDir, `# karst-ssh-login\n${check.script}`), { maxStdoutBytes: LOGIN_STDOUT_BYTES });
  if (out.transport === true) return `ssh ${name}: transport failed during the ${core} sign-in check`;
  if (check.signedIn(out.stdout)) return undefined;
  return `ssh ${name}: ${core} is not signed in on the remote; run \`${check.fix}\` on ${remote.user}@${remote.host}`;
}

async function resolveSteps(input: SshResolveInput, signal: AbortSignal, extendBound: (ms: number) => void): Promise<SshResolution> {
  const name = input.remoteName;
  const deps = input.deps ?? {};
  const remote = input.remotes?.[name];
  if (remote === undefined) return { ok: false, reason: `ssh: remote '${name}' is not in remotes` };
  if (remote.mode === 'docker') return resolveDockerSteps(input, name, remote, deps, signal, extendBound);
  if (!isSshCore(input.core)) return { ok: false, reason: `${input.core}: ssh backend unsupported` };
  const worktree = input.worktree;
  if (!worktree?.branch) return { ok: false, reason: 'ssh: ticket has no worktree branch to clone' };
  const ssh = deps.ssh ?? NODE_SSH_PROCESS;
  const controlDir = deps.controlDir ?? sshControlDir();
  const control = await (deps.ensureControlDir ?? ensureSshControlDir)(controlDir);
  if (!control.ok) return control;
  const pre = await (deps.preflight ?? sshPreflight)(name, remote, ssh, { controlDir, core: input.core });
  if (!pre.ok) return pre;
  const coreBin = pre.facts.coreBin ?? input.core;
  const notSignedIn = await checkLogin(ssh, remote, controlDir, name, input.core, coreBin);
  if (notSignedIn !== undefined) return { ok: false, reason: notSignedIn };
  const sandboxName = sshSandboxName(input.projectRoot, input.installId, input.ticketId, input.core);
  const ctx: SshCloneContext = {
    ssh, sshBin: deps.sshBin ?? SSH_BIN, host: deps.host ?? NODE_SBX_PROCESS, remote, remoteName: name, sandboxName, controlDir,
    ...(deps.debug ? { debug: deps.debug } : {}),
  };
  const cloned = await (deps.clone ?? ensureSshClone)(ctx, { hostWorktreePath: worktree.hostWorktreePath, branch: worktree.branch, ...(worktree.baseRef ? { baseRef: worktree.baseRef } : {}) });
  if (!cloned.ok) return { ok: false, reason: cloned.reason };
  await (deps.trust ?? ensureRemoteWorkspaceTrusted)({
    ssh, remote, controlDir, core: input.core, remoteCwd: sshRemotePaths(ctx).repo, remoteName: name, signal,
    ...(deps.warn ? { warn: deps.warn } : {}), ...(deps.debug ? { debug: deps.debug } : {}),
  });
  const warnings = [...pre.warnings];
  if (!pre.facts.tmux) {
    const once = deps.warnOnce ?? WINDOW_SSH_WARN_ONCE;
    const text = warnings.find((w) => w.includes('tmux not found')) ?? `ssh ${name}: tmux not found; the agent stops when the connection drops (install tmux)`;
    if (!warnings.includes(text)) warnings.push(text);
    if (!once.warned.has(name)) {
      once.warned.add(name);
      deps.warn?.(text);
    }
  }
  const runner = createSshSessionRunner({
    ssh, sshBin: ctx.sshBin, host: ctx.host, remote, remoteName: name, sandboxName,
    projectPrefix: sshProjectPrefix(input.projectRoot, input.installId), controlDir, core: input.core,
    ticketId: input.ticketId, hostWorktreePath: worktree.hostWorktreePath, tmux: pre.facts.tmux, coreBin,
    ...(deps.trustDir !== undefined ? { trustDir: deps.trustDir } : {}),
    ...(deps.registry ? { registry: deps.registry } : {}), ...(deps.debug ? { debug: deps.debug } : {}),
  });
  return { ok: true, runner, names: { remote: name, name: sandboxName }, warnings };
}

export async function resolveSsh(input: SshResolveInput): Promise<SshResolution> {
  // Trust first: an unconfirmed remote gets no connection at all.
  if (!input.remoteTrusted(input.remoteName)) return { ok: false, reason: `ssh: remote '${input.remoteName}' not confirmed` };
  const timeoutMs = input.deps?.timeoutMs ?? SSH_RESOLVE_TIMEOUT_MS;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let boundMs = timeoutMs;
  /** True once the race is over: a step still in flight must not re-arm the deadline. */
  let finished = false;
  let expire: (() => void) | undefined;
  const timedOut = new Promise<SshResolution>((resolve) => {
    expire = () => {
      controller.abort();
      resolve({ ok: false, reason: `ssh ${input.remoteName}: setup did not finish in ${String(Math.round(boundMs / 1000))} s` });
    };
  });
  /**
   * (Re)arm the deadline. A step that names its own longer bound (the remote
   * image build) calls this; an aborted or finished resolve ignores it, so an
   * abandoned step cannot arm a 31-minute timer after the race settled. The
   * timer never holds the process open on its own (`unref`).
   */
  const extendBound = (ms: number): void => {
    if (finished || controller.signal.aborted) return;
    boundMs = ms;
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => expire?.(), ms);
    timer.unref?.();
  };
  extendBound(timeoutMs);
  try {
    return await Promise.race([resolveSteps(input, controller.signal, extendBound), timedOut]);
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  } finally {
    finished = true;
    if (timer !== undefined) clearTimeout(timer);
  }
}
