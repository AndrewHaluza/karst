import { randomBytes } from 'node:crypto';
import type { RemoteDef } from '../../manifest/types.js';
import { runProcess, type GateProcessRunner } from '../../workflow/gates/run.js';
import { autonomousLaunch } from '../autonomousLaunch.js';
import { SANDBOX_BRIDGE_MOUNT_ROOT, type BridgePaths } from '../bridge/bridgeDir.js';
import { withoutHostOnlyEnv } from '../cliEnv.js';
import { disposeResult, disposeStep, type DisposeResult, type DisposeStep } from '../disposeResult.js';
import type { SbxProcess } from '../sbx/sbxProcess.js';
import type { DockerMemoryLimits } from '../docker/dockerMemory.js';
import type { DockerNames } from '../docker/dockerNames.js';
import { OPENCODE_IMAGE } from '../docker/dockerImage.js';
import { CONTAINER_REPO, type LinuxUser } from '../docker/dockerRunArgs.js';
import { createDockerSessionRunner, type DockerMountRoot } from '../docker/dockerRunner.js';
import type { SshDockerCore } from '../sandboxCores.js';
import type {
  DiffResult,
  InteractiveLaunchSpec,
  PlacedInteractiveLaunch,
  PublishResult,
  RefreshOptions,
  SandboxProbe,
  SandboxTicketRef,
  SessionRunner,
  ShellCommandResult,
  StepOutcome,
  SyncResult,
} from '../sessionRunner.js';
import { remoteAssetsDir, PROXY_BUNDLE } from './sshDockerAssets.js';
import {
  diffSshDockerClone,
  fetchSshDockerClone,
  refreshSshDockerClone,
  syncFromSshDockerClone,
  type SshDockerCloneContext,
} from './sshDockerClone.js';
import { removeRemoteServiceEnv, serviceEnvFilePath, writeRemoteDockerEnvFile } from './sshDockerEnv.js';
import { sshDockerGateProcess } from './sshDockerGate.js';
import { sshDockerArgv, sshDockerProcess } from './sshDockerProcess.js';
import { disposeTarget } from './sshDisposeGuard.js';
import { remoteEnv } from './sshEnv.js';
import { SSH_BIN, sshArgv, type SshProcess } from './sshProcess.js';
import { sshQuote } from './sshQuote.js';

/**
 * The `mode: docker` ssh runner (D822, edits 3, 8, 9, 9a, 10, 12, 13).
 *
 * A REMOTE Docker daemon, driven by the LOCAL docker backend: `base` is
 * `createDockerSessionRunner` over `sshDockerProcess`, so hardening, the
 * `--internal` network, the proxy sidecar, setup windows, port relays and the
 * gate wrapper are the exact local implementations — there is no second docker
 * runner to drift. What changes is only where things live:
 *
 * - the bridge dir, the proxy bundle and the env files are paths on the REMOTE
 *   (`<remoteDir>/<name>/…`, `<remoteDir>/.karst-assets/<revision>`);
 * - the clone is seeded, synced and refreshed with the D554 bundle functions
 *   (`sshDockerClone.ts`): host git stays local, and no host temp dir is ever
 *   bind-mounted into a remote container;
 * - the gate, the shell and the interactive launch are ssh commands, and every
 *   secret travels in a 0600 remote env file over stdin (`--env-file`).
 *
 * The container is a real isolation boundary on the remote, so the runner says
 * `enforcesSandbox: true` and grants the autonomous opencode launch
 * (`@arch:AC-31`). Baseline host services are refused: on a remote daemon
 * `host-gateway` is the VM itself, not the user's machine (D823).
 */

/**
 * Where a remote launch mounts from (`@arch:AC-39`). Both fields are paths on
 * the REMOTE host; `DockerMountRoot` keeps them optional because the local
 * backend has neither.
 */
export interface SshDockerMountRoot extends DockerMountRoot {
  /** `<remoteDir>/.karst-assets/<revision>`: uploaded once per revision, sha256-verified. */
  readonly assetsDir: string;
  /** `<remoteDir>/<name>/bridge/<ticketId>`: bind-mounted at `/karst-bridge/<ticketId>`. */
  readonly bridgeDir: string;
}

/** `<remoteDir>/.karst-assets/<revision>` and `<remoteDir>/<name>/bridge/<ticketId>`. */
export function sshDockerMountRoot(
  remoteDir: string,
  sandboxName: string,
  ticketId: number,
  revision?: string,
): SshDockerMountRoot {
  if (!Number.isInteger(ticketId) || ticketId < 1) {
    throw new Error(`ssh docker: invalid ticket id ${JSON.stringify(ticketId)}`);
  }
  const base = remoteDir.replace(/\/+$/, '');
  return {
    assetsDir: remoteAssetsDir(base, revision),
    bridgeDir: `${base}/${sandboxName}/bridge/${ticketId}`,
  };
}

/** Baseline host services are a host feature: on a remote daemon `host-gateway` is the VM. */
export const SSH_DOCKER_HOST_SERVICES_ERROR = 'ssh docker mode: host services are not supported';

export interface SshDockerRunnerOptions {
  readonly ssh: SshProcess;
  /** The ssh executable of the launch and of `pipe`; `SSH_BIN` in production. */
  readonly sshBin?: string;
  /** Host-side git (bundles). Every call runs LOCALLY in the host worktree. */
  readonly host: SbxProcess;
  readonly remote: RemoteDef;
  /** The manifest name of the remote; every reason names it (`ssh <name>: …`). */
  readonly remoteName: string;
  /** The checked, 0700 ControlMaster dir (`/tmp/karst-ssh-<uid>/`). */
  readonly controlDir: string;
  readonly core: SshDockerCore;
  readonly ticketId: number;
  /** `karst-<hash8>-<ticketId>-<core>` (from `dockerNames`, salted with the ssh install id). */
  readonly names: DockerNames;
  /** The REMOTE user (`sshPreflight` uid/gid, `os: 'linux'`): never the host's. */
  readonly user: LinuxUser | undefined;
  /** The worktree on the host: the ssh client's cwd and the path the adapter's args name. */
  readonly hostWorktreePath: string;
  /** `sshProjectPrefix(projectRoot, installId)`: `dispose` refuses a name outside it. */
  readonly projectPrefix: string;
  readonly memory?: DockerMemoryLimits;
  /** The host gate boundary `sshDockerGateProcess` wraps (default `runProcess`). */
  readonly gateProcess?: GateProcessRunner;
  readonly newRunId?: () => string;
  readonly debug?: (message: string) => void;
}

const TEXT_STDOUT_BYTES = 64 * 1024;

function tail(text: string): string {
  const line = text.trim().split('\n').filter((l) => l.trim() !== '').at(-1);
  return line === undefined ? '' : line.slice(0, 300);
}

export function createSshDockerSessionRunner(opts: SshDockerRunnerOptions): SessionRunner {
  const sshBin = opts.sshBin ?? SSH_BIN;
  const newRunId = opts.newRunId ?? (() => randomBytes(8).toString('hex'));
  const remoteDir = opts.remote.remoteDir.replace(/\/+$/, '');
  const workspace = `${remoteDir}/${opts.names.container}`;
  const mountRoot = sshDockerMountRoot(remoteDir, opts.names.container, opts.ticketId);
  const envFile = `${workspace}/env/docker.env`;
  /** Where the AGENT sees the bridge dir (the mount target, identical to local docker). */
  const evidenceDir = `${SANDBOX_BRIDGE_MOUNT_ROOT}/${opts.ticketId}`;
  const dockerProc = sshDockerProcess(opts.remote, opts.ssh, { controlDir: opts.controlDir, sshBin });
  const base = createDockerSessionRunner({
    proc: dockerProc,
    core: opts.core,
    names: opts.names,
    user: opts.user,
    mountRoot,
    envFile,
    newRunId,
    gateProcess: sshDockerGateProcess({
      ssh: opts.ssh, sshBin, remote: opts.remote, remoteName: opts.remoteName, controlDir: opts.controlDir,
      workspace, hostWorktreePath: opts.hostWorktreePath, newRunId,
      gateProcess: opts.gateProcess ?? runProcess,
      ...(opts.debug ? { debug: opts.debug } : {}),
    }),
    evidenceDir,
    ...(opts.memory ? { memory: opts.memory } : {}),
    proxy: { script: `${mountRoot.assetsDir}/${PROXY_BUNDLE}` },
  });
  const cloneCtx: SshDockerCloneContext = {
    ssh: opts.ssh, sshBin, host: opts.host, remote: opts.remote, remoteName: opts.remoteName,
    controlDir: opts.controlDir, image: OPENCODE_IMAGE, volume: opts.names.repoVolume, user: opts.user,
    ...(opts.debug ? { debug: opts.debug } : {}),
  };
  const cloneInput = (ticket: SandboxTicketRef) => ({
    hostWorktreePath: ticket.hostWorktreePath,
    branch: ticket.branch,
    ...(ticket.baseRef ? { baseRef: ticket.baseRef } : {}),
  });
  /** The dirs a launch needs on the remote, parents first (all 0700, symlink/owner guarded). */
  const launchDirs = [
    workspace,
    `${workspace}/bridge`,
    mountRoot.bridgeDir,
    `${mountRoot.bridgeDir}/results`,
    `${mountRoot.bridgeDir}/inbox`,
    `${workspace}/gates`,
    `${workspace}/env`,
  ];

  return {
    kind: 'ssh',
    enforcesSandbox: true,
    autonomous: base.autonomous,
    /**
     * Write `<ws>/env/docker.env` BEFORE the terminal opens. The docker client on
     * the remote reads it as `--env-file`; the body goes over stdin, so no env
     * VALUE ever reaches an argv. Host paths are rewritten to the container's
     * (`/work/repo`, `/karst-bridge/<ticketId>`), and the opencode config dir
     * points into the bridge mount.
     */
    prepareInteractive: async (spec: InteractiveLaunchSpec): Promise<void> => {
      const runDir = `${SANDBOX_BRIDGE_MOUNT_ROOT}/${spec.ticketId}`;
      const autoEnv = autonomousLaunch(opts.core, { enforcesSandbox: true }).env(withoutHostOnlyEnv(spec.env));
      const env = remoteEnv(autoEnv, {
        hostWorktreePath: spec.hostWorktreePath,
        remoteWorktreePath: CONTAINER_REPO,
        ...(spec.bridgeDir !== undefined ? { hostBridgeDir: spec.bridgeDir } : {}),
        remoteBridgeDir: runDir,
      }, opts.debug);
      env['OPENCODE_CONFIG_DIR'] = `${runDir}/${opts.core}/opencode-config`;
      await writeRemoteDockerEnvFile({
        ssh: opts.ssh, remote: opts.remote, remoteName: opts.remoteName, controlDir: opts.controlDir,
        workspace, file: envFile, dirs: launchDirs, env,
      });
    },
    /**
     * `base` builds the full `docker run` argv against the remote bridge mount and
     * the env file; the ssh layer only prefixes `docker` and appends `-t`.
     */
    placeInteractive: (spec: InteractiveLaunchSpec): PlacedInteractiveLaunch => {
      const placed = base.placeInteractive(spec);
      // The local ssh client gets no launch env: the remote env is the env file.
      return {
        cwd: spec.hostWorktreePath,
        shellPath: sshBin,
        shellArgs: sshDockerArgv(opts.remote, opts.controlDir, placed.shellArgs, { flags: ['-t'] }),
        env: {},
      };
    },
    bridgeRunDir: (paths: BridgePaths): string => paths.runDir,
    // The clone lives on the remote daemon: bundles only, host git stays local.
    sync: (ticket: SandboxTicketRef): Promise<SyncResult> => syncFromSshDockerClone(cloneCtx, cloneInput(ticket)),
    fetchClone: (ticket: SandboxTicketRef): Promise<StepOutcome> => fetchSshDockerClone(cloneCtx, cloneInput(ticket)),
    diff: (ticket: SandboxTicketRef): Promise<DiffResult> => diffSshDockerClone(cloneCtx, cloneInput(ticket)),
    refresh: (ticket: SandboxTicketRef, refreshOpts?: RefreshOptions): Promise<SyncResult> =>
      refreshSshDockerClone(cloneCtx, cloneInput(ticket), refreshOpts),
    shellCommand: async (ticket: SandboxTicketRef): Promise<ShellCommandResult> => {
      const res = await base.shellCommand!(ticket);
      if (!res.ok) return res;
      return { ok: true, cmd: sshBin, args: sshDockerArgv(opts.remote, opts.controlDir, res.args, { flags: ['-t'] }) };
    },
    // The relay listens on the REMOTE loopback; the ssh tunnel carries it to the host.
    publishPort: async (mapping): Promise<PublishResult> => {
      const res = await base.publishPort!(mapping);
      return res.ok ? { ok: true, remotePort: mapping.hostPort } : res;
    },
    unpublishPort: (mapping) => base.unpublishPort!(mapping),
    listPorts: () => base.listPorts!(),
    hasSandbox: async (): Promise<boolean> => base.hasSandbox!(),
    probeSandbox: (): Promise<SandboxProbe> => base.probeSandbox!(),
    canHostServices: async (): Promise<boolean> => base.canHostServices!(),
    stopServices: async (): Promise<void> => base.stopServices!(),
    stop: async (): Promise<void> => base.stop!(),
    runGate: base.runGate!,
    // A launch the guard discarded after this runner resolved must not leave the remote proxy up.
    abortLaunch: async (): Promise<void> => { await base.abortLaunch?.(); },
    setupWindow: (hosts) => base.setupWindow!(hosts),
    windowNeedsIdle: true,
    /**
     * A baseline host port names THIS machine. On a remote daemon
     * `host-gateway` is the VM, so an allow would silently reach the wrong
     * service: refuse a non-empty set instead (D823). The proxy spec therefore
     * never carries `hostPorts` either.
     */
    allowHostPorts: async (ports: readonly number[]): Promise<StepOutcome> =>
      ports.length === 0 ? { ok: true } : { ok: false, reason: SSH_DOCKER_HOST_SERVICES_ERROR },
    writeServiceEnv: async (key: string, env: Readonly<Record<string, string>>): Promise<string> => {
      const file = serviceEnvFilePath(workspace, key);
      await writeRemoteDockerEnvFile({
        ssh: opts.ssh, remote: opts.remote, remoteName: opts.remoteName, controlDir: opts.controlDir,
        workspace, file, dirs: [workspace, `${workspace}/env`], env,
      });
      return file;
    },
    removeServiceEnv: async (key: string): Promise<void> => {
      await removeRemoteServiceEnv(opts.ssh, opts.remote, opts.controlDir, workspace, key);
    },
    /**
     * All five docker objects (the base) plus `<remoteDir>/<name>` — the bridge
     * dir, the env files and the gate records. The `disposeTarget` guard runs
     * FIRST, exactly like the direct runner: a name outside this project's
     * prefix, or a path that is not the workspace, refuses the whole dispose
     * with zero docker calls — a placement row from another project or another
     * install's id must never delete a foreign clone or volume.
     */
    dispose: async (ticket: SandboxTicketRef): Promise<DisposeResult> => {
      // `remoteDir` is already stripped above, so the guard compares the SAME
      // path the workspace was built from (a manifest entry ending in `/` would
      // otherwise refuse its own workspace).
      const target = disposeTarget(remoteDir, opts.names.container, opts.projectPrefix);
      if (!target.ok || target.path !== workspace) {
        const reason = target.ok ? `ssh dispose: refused ${target.path} (not the workspace ${workspace})` : target.reason;
        return disposeResult([{ step: 'dispose guard', status: 'failed', stderr: reason }]);
      }
      const dockerRes = await base.dispose!(ticket);
      const removed = await opts.ssh.run(
        sshArgv(opts.remote, opts.controlDir, `# karst-ssh-docker-dispose\nrm -rf -- ${sshQuote(target.path)}`),
        { maxStdoutBytes: TEXT_STDOUT_BYTES },
      );
      const step: DisposeStep = removed.transport === true
        ? { step: 'workspace', status: 'failed', stderr: `ssh ${opts.remoteName}: transport failed during workspace removal: ${tail(removed.stderr)}` }
        : disposeStep('workspace', removed);
      return disposeResult([...dockerRes.steps, step]);
    },
  };
}
