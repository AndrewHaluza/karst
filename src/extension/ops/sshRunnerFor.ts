import { dockerKillContext } from '../../agent/backendProbe.js';
import { dockerNamesFromContainer } from '../../agent/docker/dockerNames.js';
import { resolveDockerMemoryLimits, type SandboxMemoryConfig } from '../../agent/docker/dockerMemory.js';
import { linuxUser } from '../../agent/docker/resolveDocker.js';
import type { LinuxUser } from '../../agent/docker/dockerRunArgs.js';
import { isRemoteTrusted, readRemoteTrust } from '../../agent/ssh/remoteTrust.js';
import { ensureSshControlDir, sshControlDir, type SshControlResult } from '../../agent/ssh/sshControlDir.js';
import { createSshDockerSessionRunner } from '../../agent/ssh/sshDockerRunner.js';
import { sshDockerProcess } from '../../agent/ssh/sshDockerProcess.js';
import { WINDOW_SSH_GATE_REGISTRY, type SshGateRegistry } from '../../agent/ssh/sshGateRegistry.js';
import { SANDBOX_NAME_RE, sshProjectPrefix } from '../../agent/ssh/sshNames.js';
import { NODE_SSH_PROCESS, sshArgv, type SshProcess } from '../../agent/ssh/sshProcess.js';
import { createSshSessionRunner } from '../../agent/ssh/sshRunner.js';
import { defaultSshTunnels } from '../../agent/ssh/sshServices.js';
import type { TunnelRegistry } from '../../agent/ssh/sshTunnels.js';
import { SSH_CORES, SSH_DOCKER_CORES, type SshCore, type SshDockerCore } from '../../agent/sandboxCores.js';
import { NODE_SBX_PROCESS, type SbxProcess } from '../../agent/sbx/sbxProcess.js';
import type { SessionRunner } from '../../agent/sessionRunner.js';
import type { RemoteDef } from '../../manifest/types.js';
import type { TicketPlacement } from '../../store/placement.js';
import type { GateProcessRunner } from '../../workflow/gates/run.js';
import { blockedSshRunner, sshPlacementTarget } from './sshPlacementOps.js';

/**
 * The ONE factory of the ssh runner of a host step (D826). `sandboxRunnerFor`
 * and `ticketSandboxRunner` both call it for a recorded `ssh` placement, so the
 * trust check applies to every sync, diff, shell, gate, service and removal.
 *
 * The checks run in this order, and each failure gives `blockedSshRunner`
 * with a reason (never `undefined`, never a host runner, zero ssh calls):
 * the placement names `<remote>/<name>`, the remote is in `remotes`, the user
 * confirmed this exact definition (`isRemoteTrusted`, D553), the install id is
 * loaded, the name is valid, the ticket has a worktree. Then the mode decides
 * the runner: `direct` needs a core `SSH_CORES` can host, `docker` (D822) only
 * `opencode`/`opencode2`; only then `createSshSessionRunner` /
 * `createSshDockerSessionRunner`.
 */
export interface SshRunnerDeps {
  /** The manifest's `remotes`, read at each call. */
  readonly remotes: () => Readonly<Record<string, RemoteDef>> | undefined;
  /** The per-install id (`ssh/install-id`); undefined until it is loaded. */
  readonly installId: () => string | undefined;
  /** The dir of `ssh-trust.json` (globalStorage), read at each call. */
  readonly globalStorageDir: string;
  readonly ssh?: SshProcess;
  /** The ssh executable (the fake's path in an integration test); `SSH_BIN` in production. */
  readonly sshBin?: string;
  /** Host-side git (bundle fetch and merge). */
  readonly host?: SbxProcess;
  /** The resolver's registry (`WINDOW_SSH_GATE_REGISTRY` by default): one set of live gate run ids per window. */
  readonly registry?: SshGateRegistry;
  readonly controlDir?: string;
  readonly ensureControlDir?: (dir: string) => Promise<SshControlResult>;
  /** The host gate boundary `runGate` wraps (tests). */
  readonly gateProcess?: GateProcessRunner;
  /**
   * The window's ssh tunnel registry (D823): `-L` published ports and shared
   * `-R` host services. One per window; the window disposes it on reload.
   * Default `windowTunnelRegistry` over `ssh`.
   */
  readonly tunnels?: TunnelRegistry;
  /** INFO lines (the unenforced direct setup window). */
  readonly info?: (message: string) => void;
  readonly warn?: (message: string) => void;
  readonly debug?: (message: string) => void;
}

export interface SshRunnerTicket {
  readonly ticketId: number;
  /** The sandbox name hash input the launch used (the manifest file, else the worktree path). */
  readonly projectRoot: string;
  /** The ticket's (cloned) host worktree: the gate cwd and the prefix `runGate` maps to `<ws>/repo`. */
  readonly hostWorktreePath: string | undefined;
  /** The manifest's `sandboxMemory`: a one-shot gate container on a remote docker gets the same limits. */
  readonly sandboxMemory?: SandboxMemoryConfig;
  /**
   * The REMOTE Docker VM size (bytes), when the caller really knows it: the base
   * of those limits. The launch resolve probes the remote daemon for it; a host
   * step has no remote preflight, so it must NOT pass this host's VM size
   * (a limit sized for this machine could exceed the remote VM).
   */
  readonly memTotalBytes?: number;
}

export const SSH_DEPS_MISSING = 'ssh: the remote runner is not available in this step';

function isSshCore(core: string): core is SshCore {
  return (SSH_CORES as readonly string[]).includes(core);
}

function isSshDockerCore(core: string): core is SshDockerCore {
  return (SSH_DOCKER_CORES as readonly string[]).includes(core);
}

/** The refused core of a `mode: docker` remote: only the image's opencode v1/v2 exist there. */
function sshDockerCoreRefusal(core: string): string {
  return `${core === '' ? 'no core' : core}: ssh docker mode supports only opencode, opencode2`;
}

/** The runner of a recorded ssh placement, or a refusing runner with the reason. */
export function sshRunnerFor(deps: SshRunnerDeps | undefined, placement: TicketPlacement, ticket: SshRunnerTicket): SessionRunner {
  const target = sshPlacementTarget(placement);
  if (target === undefined) return blockedSshRunner(`ssh placement of ticket ${String(ticket.ticketId)} names no <remote>/<name>`);
  const name = target.remote;
  if (deps === undefined) return blockedSshRunner(SSH_DEPS_MISSING);
  const def = deps.remotes()?.[name];
  if (def === undefined) return blockedSshRunner(`ssh remote ${name} not in karst.yml`);
  // Trust before anything else that could reach the remote (D553 contract C1).
  if (!isRemoteTrusted(readRemoteTrust(deps.globalStorageDir, deps.warn), name, def)) return blockedSshRunner(`ssh remote ${name} not confirmed`);
  const installId = deps.installId();
  if (installId === undefined) return blockedSshRunner('ssh: the karst install id is not available');
  const core = placement.core ?? '';
  if (!SANDBOX_NAME_RE.test(target.sandboxName)) return blockedSshRunner(`ssh: invalid sandbox name ${JSON.stringify(target.sandboxName)}`);
  if (ticket.hostWorktreePath === undefined || ticket.hostWorktreePath === '') return blockedSshRunner(`ssh: ticket ${String(ticket.ticketId)} has no worktree`);
  const controlDir = deps.controlDir ?? sshControlDir();
  const projectPrefix = sshProjectPrefix(ticket.projectRoot, installId);
  // Captured here: a closure below cannot rely on the narrowing of a property.
  const hostWorktreePath = ticket.hostWorktreePath;
  const ssh = deps.ssh ?? NODE_SSH_PROCESS;
  // Resolved once: every docker rebuild (`withRemoteDockerUser`) shares one registry.
  const tunnels = deps.tunnels ?? defaultSshTunnels(ssh, deps);
  // `warn` goes only to the tunnel registry above: a runner given `tunnels` reads no `warn`.
  const log = { ...(deps.info ? { info: deps.info } : {}), ...(deps.debug ? { debug: deps.debug } : {}) };
  if (def.mode === 'docker') {
    // The remote image ships opencode v1 and v2 only (D822): no claude, no codex, no agy.
    if (!isSshDockerCore(core)) return blockedSshRunner(sshDockerCoreRefusal(core));
    // The name is the ssh sandbox name (already validated): every docker object comes off it.
    const build = (user: LinuxUser | undefined): SessionRunner => createSshDockerSessionRunner({
      ssh, sshBin: deps.sshBin,
      host: deps.host ?? NODE_SBX_PROCESS, remote: def, remoteName: name,
      names: dockerNamesFromContainer(target.sandboxName), projectPrefix, controlDir, core,
      ticketId: ticket.ticketId, hostWorktreePath,
      trustDir: deps.globalStorageDir,
      // A host step has no preflight (`withRemoteDockerUser` probes the REMOTE ids
      // for the ops that need them): the launch resolved runs as the remote user.
      user,
      memory: resolveDockerMemoryLimits(ticket.memTotalBytes, ticket.sandboxMemory),
      tunnels,
      ...(deps.gateProcess ? { gateProcess: deps.gateProcess } : {}), ...(deps.debug ? { debug: deps.debug } : {}),
    });
    const runner = withRemoteDockerUser(build(undefined), build, () => remoteDockerUser(ssh, def, controlDir));
    return withControlDir(runner, () => (deps.ensureControlDir ?? ensureSshControlDir)(controlDir));
  }
  if (!isSshCore(core)) return blockedSshRunner(`${core === '' ? 'no core' : core}: ssh backend unsupported`);
  const runner = createSshSessionRunner({
    ssh, host: deps.host ?? NODE_SBX_PROCESS, remote: def, remoteName: name,
    sandboxName: target.sandboxName, projectPrefix, controlDir,
    core, ticketId: ticket.ticketId, hostWorktreePath: ticket.hostWorktreePath,
    trustDir: deps.globalStorageDir,
    // `tmux` is read only by `placeInteractive`; a host step never launches (`stop` kills a tmux session either way).
    tmux: false,
    registry: deps.registry ?? WINDOW_SSH_GATE_REGISTRY,
    tunnels, ...log,
    ...(deps.gateProcess ? { gateProcess: deps.gateProcess } : {}),
  });
  return withControlDir(runner, () => (deps.ensureControlDir ?? ensureSshControlDir)(controlDir));
}

/**
 * The kill context of a ticket whose recorded placement is an ssh remote in
 * `mode: docker` (D822): `docker info` + `docker ps` run on the REMOTE daemon,
 * through the same trust check as every other host step. Undefined for every
 * other placement (and for a removed or unconfirmed remote): zero ssh calls.
 */
export function sshDockerKillContextFor(
  deps: SshRunnerDeps | undefined,
  placement: TicketPlacement | null | undefined,
): (() => Promise<string | undefined>) | undefined {
  const target = sshPlacementTarget(placement);
  if (target === undefined || deps === undefined) return undefined;
  const def = deps.remotes()?.[target.remote];
  if (def === undefined || def.mode !== 'docker') return undefined;
  if (!isRemoteTrusted(readRemoteTrust(deps.globalStorageDir, deps.warn), target.remote, def)) return undefined;
  const controlDir = deps.controlDir ?? sshControlDir();
  return async (): Promise<string | undefined> => {
    const control = await (deps.ensureControlDir ?? ensureSshControlDir)(controlDir)
      .catch((err: unknown): SshControlResult => ({ ok: false, reason: err instanceof Error ? err.message : String(err) }));
    if (!control.ok) {
      // The reason of a thrown check is the only trace of why the kill context is unavailable.
      deps.debug?.(`[ssh ${target.remote}] docker kill context: control dir check failed: ${control.reason}`);
      return undefined;
    }
    return dockerKillContext(sshDockerProcess(def, deps.ssh ?? NODE_SSH_PROCESS, { controlDir }));
  };
}

/** The async ops that reach the remote: each first makes sure the control dir is private. */
const REMOTE_OPS = [
  'sync', 'refresh', 'fetchClone', 'diff', 'shellCommand', 'stop', 'dispose', 'rebuild', 'hasSandbox', 'probeSandbox',
  'oomReport', 'ensureWritable', 'ensureCloneReady', 'prepareInteractive', 'runGate',
  // `mode: docker` remote ops (D822): a setup window, a port relay, a service env
  // file and the host-service allow all reach the remote daemon.
  'setupWindow', 'canHostServices', 'stopServices', 'publishPort', 'unpublishPort', 'listPorts', 'allowHostPorts',
  'writeServiceEnv', 'removeServiceEnv',
  // D823: one `ss -ltn` call before a spin allocates ports.
  'probeRemotePorts',
] as const satisfies readonly (keyof SessionRunner)[];

/**
 * The docker ops whose argv carries `--user`: each spawns a container that
 * WRITES the clone volume or the bridge dir, both owned by the remote uid.
 */
const USER_OPS = ['sync', 'refresh', 'fetchClone', 'diff', 'runGate', 'canHostServices'] as const;

/** One short remote read: the remote uid/gid. */
const USER_STDOUT_BYTES = 1024;
/** `id -u; id -g` prints exactly two decimal lines (the seam runs `sh -c`, so no login profile runs). */
const REMOTE_IDS_RE = /^(\d+)\n(\d+)\n?$/;

/** The uid/gid of the probe's stdout, or undefined when it is not exactly two decimal lines. */
export function parseRemoteUser(stdout: string): LinuxUser | undefined {
  const ids = REMOTE_IDS_RE.exec(stdout);
  if (ids === null) return undefined;
  return linuxUser('linux', Number(ids[1]), Number(ids[2]));
}

/**
 * The REMOTE uid/gid, asked over ssh (one call): the launch's preflight facts
 * are not in the placement, and the volumes were chowned to that user. A failed
 * probe is `undefined` (the image's own user), never this host's ids.
 */
async function remoteDockerUser(ssh: SshProcess, remote: RemoteDef, controlDir: string): Promise<LinuxUser | undefined> {
  const out = await ssh.run(sshArgv(remote, controlDir, '# karst-ssh-docker-user\nid -u; id -g'), { maxStdoutBytes: USER_STDOUT_BYTES });
  if (out.transport === true || out.code !== 0) return undefined;
  return parseRemoteUser(out.stdout);
}

type AnyOp = (...args: unknown[]) => Promise<unknown>;

/**
 * A host step has no preflight, so the remote uid/gid are unknown when its
 * runner is built — but every container that writes the volume must run as
 * that user. The ops that spawn one resolve the ids ONCE (one ssh call) and
 * delegate to a runner built with them; every other op (a `docker exec`, a
 * probe, a dispose) keeps the preflight-free runner and makes no extra call.
 */
function withRemoteDockerUser(
  provisional: SessionRunner,
  build: (user: LinuxUser | undefined) => SessionRunner,
  probe: () => Promise<LinuxUser | undefined>,
): SessionRunner {
  /** `retry` = the probe did not answer: that result is handed out for THIS op but never kept. */
  let resolved: Promise<{ readonly runner: SessionRunner; readonly retry: boolean }> | undefined;
  const real = async (): Promise<SessionRunner> => {
    const pending = resolved ?? (async () => {
      try {
        const user = await probe();
        return { runner: build(user), retry: user === undefined };
      } catch {
        return { runner: build(undefined), retry: true };
      }
    })();
    resolved = pending;
    const out = await pending;
    // A failed probe is not cached (like `withControlDir`): a transient ssh blip must not pin the
    // image's own user for the runner's lifetime, or a later op writes a volume it does not own.
    if (out.retry) resolved = undefined;
    return out.runner;
  };
  const guarded: Partial<Record<(typeof USER_OPS)[number], AnyOp>> = {};
  for (const key of USER_OPS) {
    const op = provisional[key] as AnyOp | undefined;
    // Stryker disable next-line ConditionalExpression: equivalent, the ssh docker runner implements every USER_OPS op
    if (op === undefined) continue;
    guarded[key] = async (...args: unknown[]): Promise<unknown> => ((await real())[key] as AnyOp)(...args);
  }
  return { ...provisional, ...(guarded as Partial<SessionRunner>) };
}

/**
 * Every ssh argv names `<controlDir>/%C`, and `resolveSsh` checks that the dir
 * is private (no planted symlink) before the first ssh. A host step has no
 * resolve, so the first remote op of this runner runs the same check; a failed
 * check refuses that op with the reason, through `blockedSshRunner`.
 */
function withControlDir(runner: SessionRunner, ensure: () => Promise<SshControlResult>): SessionRunner {
  let ready: Promise<SshControlResult> | undefined;
  const check = (): Promise<SshControlResult> => {
    const pending = ready ?? ensure();
    ready = pending;
    // Only a good check is kept: a failed one is tried again on the next op.
    // A new check starts only after this one is dropped, so `ready` is still `pending` here.
    void pending.then((r) => { if (!r.ok) ready = undefined; }, () => { ready = undefined; });
    return pending;
  };
  const guarded: Partial<Record<(typeof REMOTE_OPS)[number], AnyOp>> = {};
  for (const key of REMOTE_OPS) {
    const op = runner[key] as AnyOp | undefined;
    // Stryker disable next-line ConditionalExpression: equivalent, the ssh runner implements every REMOTE_OPS op
    if (op === undefined) continue;
    guarded[key] = async (...args: unknown[]): Promise<unknown> => {
      const control = await check().catch((err: unknown) => ({ ok: false as const, reason: err instanceof Error ? err.message : String(err) }));
      if (control.ok) return op(...args);
      return (blockedSshRunner(control.reason)[key] as AnyOp)(...args);
    };
  }
  return { ...runner, ...(guarded as Partial<SessionRunner>) };
}
