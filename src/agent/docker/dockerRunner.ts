import { randomBytes } from 'node:crypto';
import { autonomousLaunch } from '../autonomousLaunch.js';
import { runProcess } from '../../workflow/gates/run.js';
import type { GateProcessRunner, PlacedInteractiveLaunch, RefreshOptions, SandboxProbe, SandboxTicketRef, SessionRunner } from '../sessionRunner.js';
import { EVIDENCE_DIR_ENV, SANDBOX_ENV } from '../sbx/sbxRunner.js';
import { disposeResult, disposeStep, type DisposeResult } from '../disposeResult.js';
import { listRelayPorts, publishRelay, removeAllRelays, unpublishRelay } from './dockerPorts.js';
import { withoutHostOnlyEnv } from '../cliEnv.js';
import { chownVolumes, ensureClone, ensureVolume, diffFromClone, fetchFromClone, OS_TEMP_DIRS, refreshClone, syncFromClone, type CloneContext, type StepResult, type TempDirs } from './dockerClone.js';
import { seedAgyAutonomousState, seedAgyCredentials, seedOpencode2Credentials } from './dockerCredentials.js';
import type { DockerCore, DockerRunnerCore } from './dockerImage.js';
import type { DockerNames } from './dockerNames.js';
import { detail, DOCKER_BIN } from './dockerPreflight.js';
import type { DockerProcess } from './dockerProcess.js';
import {
  gateRunArgs,
  serviceRunArgs,
  serviceContainerName,
  headlessExecArgs,
  headlessKillArgs,
  interactiveRunArgs,
  type LinuxUser,
  rewritePaths,
} from './dockerRunArgs.js';
import type { DockerMemoryLimits } from './dockerMemory.js';
import { deniedHostsFromLog, DOCKER_ALLOWLIST, haltProxySidecar, startProxySidecar, stopProxySidecar } from './proxySidecar.js';

export interface DockerRunnerOptions {
  readonly proc: DockerProcess;
  readonly core: DockerRunnerCore;
  readonly names: DockerNames;
  readonly user: LinuxUser | undefined;
  /** opencode v1 only: the host `auth.json`, mounted read-only. */
  readonly authFile?: string;
  readonly temp?: TempDirs;
  readonly newRunId?: () => string;
  /** The host gate boundary `runGate` wraps (default `runProcess`). */
  readonly gateProcess?: GateProcessRunner;
  /** Agent-visible evidence dir (the bridge mount), exported to gates as `KARST_EVIDENCE_DIR`. */
  readonly evidenceDir?: string;
  /** What a setup window needs to recreate the proxy: its bundled script and the baseline host ports. */
  /** Resolved container memory limits; absent = no memory flags. */
  readonly memory?: DockerMemoryLimits;
  readonly proxy?: { readonly script: string; readonly hostPorts?: readonly number[] };
}

/**
 * The plain-docker runner (arch:AC-33, opencode + opencode2). Clone mode: the
 * agent works in a clone on a named volume, behind an `--internal` network
 * whose only exit is the allowlist proxy. Interactive = `docker run -it`,
 * headless = `docker exec` into that container. Never `--privileged`, never
 * the docker socket, argv arrays only, async spawns only.
 */
export function createDockerSessionRunner(opts: DockerRunnerOptions): SessionRunner {
  const newRunId = opts.newRunId ?? (() => randomBytes(8).toString('hex'));
  const ctx: CloneContext = { proc: opts.proc, names: opts.names, user: opts.user, temp: opts.temp ?? OS_TEMP_DIRS };
  const gateProcess = opts.gateProcess ?? runProcess;
  const gateEnv: Record<string, string> = { [SANDBOX_ENV]: '1', ...(opts.evidenceDir ? { [EVIDENCE_DIR_ENV]: opts.evidenceDir } : {}) };
  /** Runs `body` with a recorded in-container pid, killed on abort and when the run ends. */
  const execTracked = async <T>(signal: AbortSignal | undefined, body: (runId: string) => Promise<T>): Promise<T> => {
    const runId = newRunId();
    const kill = () => opts.proc.run(DOCKER_BIN, headlessKillArgs(opts.names.container, runId));
    const onAbort = () => void kill();
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      return await body(runId);
    } finally {
      signal?.removeEventListener('abort', onAbort);
      await kill();
    }
  };
  return {
    kind: 'docker',
    enforcesSandbox: true,
    autonomous: autonomousLaunch(opts.core, { enforcesSandbox: true }).autonomous,
    placeInteractive: (spec): PlacedInteractiveLaunch => {
      // The allow-all opencode config rides the docker client's env (by name),
      // so it reaches only the container (arch:AC-31, arch:AC-33).
      const launch = autonomousLaunch(opts.core, { enforcesSandbox: true });
      const env = launch.env(withoutHostOnlyEnv(spec.env));
      return {
        cwd: spec.hostWorktreePath,
        shellPath: DOCKER_BIN,
        shellArgs: interactiveRunArgs({
          names: opts.names, core: opts.core, user: opts.user, authFile: opts.authFile,
          hostWorktreePath: spec.hostWorktreePath, args: [...launch.args, ...spec.args], env,
          ticketId: spec.ticketId, bridgeDir: spec.bridgeDir,
          ...(opts.memory ? { memory: opts.memory } : {}),
        }),
        env,
      };
    },
    bridgeRunDir: (paths) => paths.runDir,
    // Killing the `docker exec` client leaves the process running in the
    // container; an abort also kills it there, by its recorded pid. A timeout
    // inside the spawn kills only the client too, so the kill (a no-op once the
    // process exited; it also drops the pid file) always runs when the run ends.
    runGate: async (command, args, cwd, gateOpts) => {
      const execTarget = (await containerRunning(opts.proc, opts.names.container))
        ? opts.names.container
        : (await containerRunning(opts.proc, serviceContainerName(opts.names))) ? serviceContainerName(opts.names) : null;
      if (execTarget) {
        return execTracked(gateOpts?.signal, (runId) =>
          gateProcess(DOCKER_BIN, headlessExecArgs(execTarget, runId, command, rewritePaths(args, cwd), gateEnv), cwd, gateOpts));
      }
      // The interactive container is `--rm`: once its terminal closed, a gate
      // runs in a one-shot container on the same clone, removed by name.
      // The proxy is stopped when the session ends: bring it back for the gate's network.
      if (opts.proxy) {
        await startProxySidecar(opts.proc, { proxy: opts.names.proxy, network: opts.names.network, scriptPath: opts.proxy.script, ...(opts.proxy.hostPorts ? { hostPorts: opts.proxy.hostPorts } : {}) });
      }
      const runName = `${opts.names.container}-gate-${newRunId()}`;
      const remove = () => opts.proc.run(DOCKER_BIN, ['rm', '--force', runName]);
      const onAbort = () => void remove();
      gateOpts?.signal?.addEventListener('abort', onAbort, { once: true });
      try {
        return await gateProcess(DOCKER_BIN, gateRunArgs(opts.names, opts.user, runName, command, rewritePaths(args, cwd), gateEnv, opts.memory), cwd, gateOpts);
      } finally {
        gateOpts?.signal?.removeEventListener('abort', onAbort);
        await remove();
      }
    },
    // ALLOW is a create-time env: opening and closing recreate the proxy (the caller only does so with an idle agent).
    windowNeedsIdle: true,
    setupWindow: async (hosts) => {
      if (!opts.proxy) return { ok: false, reason: 'docker: no proxy script to recreate the allowlist proxy with' };
      const spec = { proxy: opts.names.proxy, network: opts.names.network, scriptPath: opts.proxy.script, ...(opts.proxy.hostPorts ? { hostPorts: opts.proxy.hostPorts } : {}) };
      const since = new Date().toISOString();
      const opened = await startProxySidecar(opts.proc, { ...spec, allow: [...DOCKER_ALLOWLIST, ...hosts.map((h) => h.replace(/^\*\./, ''))] });
      // A failed open may leave a half-built proxy: put the baseline back before reporting.
      if (!opened.ok) { await startProxySidecar(opts.proc, spec); return opened; }
      const deniedHosts = async (): Promise<string[]> => {
        try {
          const logs = await opts.proc.run(DOCKER_BIN, ['logs', '--since', since, opts.names.proxy]);
          return logs.code === 0 ? deniedHostsFromLog(`${logs.stdout}\n${logs.stderr}`) : [];
        } catch {
          return [];
        }
      };
      return { ok: true, close: async () => { await startProxySidecar(opts.proc, spec); }, deniedHosts };
    },
    canHostServices: async () => {
      if (await containerRunning(opts.proc, opts.names.container)) return true;
      if (await containerRunning(opts.proc, serviceContainerName(opts.names))) return true;
      await opts.proc.run(DOCKER_BIN, ['rm', '--force', serviceContainerName(opts.names)]);
      return (await opts.proc.run(DOCKER_BIN, serviceRunArgs(opts.names, opts.user))).code === 0;
    },
    // The clone volume is the sandbox: it outlives the interactive container.
    hasSandbox: async () => (await probeVolume(opts.proc, opts.names.repoVolume)).state === 'present',
    probeSandbox: () => probeVolume(opts.proc, opts.names.repoVolume),
    publishPort: (m) => publishRelay(opts.proc, opts.names, m),
    unpublishPort: (m) => unpublishRelay(opts.proc, opts.names, m),
    listPorts: () => listRelayPorts(opts.proc, opts.names),
    sync: (ticket: SandboxTicketRef) => syncFromClone(ctx, ticket),
    fetchClone: (ticket: SandboxTicketRef) => fetchFromClone(ctx, ticket),
    diff: (ticket: SandboxTicketRef) => diffFromClone(ctx, ticket),
    refresh: (ticket: SandboxTicketRef, opts?: RefreshOptions) => refreshClone(ctx, ticket, opts),
    // Volumes survive a stop; the next open restarts the container.
    stop: async (): Promise<void> => {
      await opts.proc.run(DOCKER_BIN, ['stop', opts.names.container]);
      await haltProxySidecar(opts.proc, opts.names.proxy);
    },
    stopServices: async (): Promise<void> => {
      await opts.proc.run(DOCKER_BIN, ['rm', '--force', serviceContainerName(opts.names)]);
    },
    dispose: async (): Promise<DisposeResult> => {
      const n = opts.names;
      const steps = [
        disposeStep('container', await opts.proc.run(DOCKER_BIN, ['rm', '--force', n.container, serviceContainerName(n)])),
        await removeAllRelays(opts.proc, n),
        await stopProxySidecar(opts.proc, n.proxy),
        // Order matters: the network only goes once its containers are gone.
        disposeStep('network', await opts.proc.run(DOCKER_BIN, ['network', 'rm', n.network])),
        disposeStep('volumes', await opts.proc.run(DOCKER_BIN, ['volume', 'rm', '--force', n.repoVolume, n.dataVolume])),
      ];
      return disposeResult(steps);
    },
  };
}

/** `docker volume inspect`: only docker's own "No such volume" is absent; a missing CLI or a down daemon is unknown. */
async function probeVolume(proc: DockerProcess, volume: string): Promise<SandboxProbe> {
  const out = await proc.run(DOCKER_BIN, ['volume', 'inspect', volume]);
  if (out.code === 0) return { state: 'present' };
  if (out.code !== 127 && /no such volume/i.test(out.stderr)) return { state: 'absent' };
  return { state: 'unknown', reason: out.code === 127 ? `\`docker\` was not found on the PATH (${out.stderr.trim()})` : `\`docker volume inspect\` exited ${out.code}: ${out.stderr.trim()}` };
}

async function containerRunning(proc: DockerProcess, container: string): Promise<boolean> {
  const state = await proc.run(DOCKER_BIN, ['container', 'inspect', '--format', '{{.State.Running}}', container]);
  return state.code === 0 && state.stdout.trim() === 'true';
}

export interface PrepareInput {
  readonly proc: DockerProcess;
  readonly core: DockerRunnerCore;
  readonly names: DockerNames;
  readonly user: LinuxUser | undefined;
  readonly ticket: SandboxTicketRef;
  /** Host path of the bundled proxy script. */
  readonly proxyScript: string;
  /** opencode2 only: how to read the host's karst-isolated credential store. */
  readonly opencode2Host?: { readonly command: string; readonly env: Readonly<Record<string, string>> };
  readonly bridgeDir?: string;
  readonly temp?: TempDirs;
  readonly debug?: (message: string) => void;
  /** Baseline host ports the proxy lets the sandbox reach (arch:AC-32). */
  readonly hostPorts?: readonly number[];
}

async function ensureNetwork(proc: DockerProcess, network: string): Promise<StepResult> {
  if ((await proc.run(DOCKER_BIN, ['network', 'inspect', network])).code === 0) return { ok: true };
  const made = await proc.run(DOCKER_BIN, ['network', 'create', '--internal', network]);
  return made.code === 0 ? { ok: true } : { ok: false, reason: `docker network create ${network} failed: ${detail(made)}` };
}

/**
 * Everything a launch needs before its terminal exists, idempotent per ticket:
 * internal network, both volumes (handed to the linux uid when new), proxy
 * sidecar, the branch clone, and — opencode2 — credentials. The first failure
 * is the reason; the caller then fails closed to the host (arch:AC-31).
 */
export async function prepareDockerSandbox(input: PrepareInput): Promise<StepResult> {
  const { proc, names } = input;
  const ctx: CloneContext = { proc, names, user: input.user, temp: input.temp ?? OS_TEMP_DIRS };
  const network = await ensureNetwork(proc, names.network);
  if (!network.ok) return network;
  const repo = await ensureVolume(proc, names.repoVolume);
  if (!repo.ok) return repo;
  const data = await ensureVolume(proc, names.dataVolume);
  if (!data.ok) return data;
  // Every launch, not only on create: an interrupted first chown must be retried (idempotent).
  const owned = await chownVolumes(ctx);
  if (!owned.ok) return owned;
  const proxy = await startProxySidecar(proc, { proxy: names.proxy, network: names.network, scriptPath: input.proxyScript, ...(input.hostPorts ? { hostPorts: input.hostPorts } : {}) });
  if (!proxy.ok) return proxy;
  const rest = await cloneAndSeed(input, ctx);
  // The proxy is the one object with egress: never leave it up for a ticket
  // that falls back to the host. Volumes stay, so a retry keeps sessions.
  if (!rest.ok) await stopProxySidecar(proc, names.proxy);
  return rest;
}

async function cloneAndSeed(input: PrepareInput, ctx: CloneContext): Promise<StepResult> {
  const { proc, names } = input;
  let clone: StepResult;
  try {
    clone = await ensureClone(ctx, { hostWorktreePath: input.ticket.hostWorktreePath, branch: input.ticket.branch, ...(input.ticket.baseRef ? { baseRef: input.ticket.baseRef } : {}) });
  } catch (err) {
    clone = { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
  if (!clone.ok) return clone;
  if (input.core === 'opencode2' && input.opencode2Host) {
    return seedOpencode2Credentials({
      proc, names, user: input.user,
      hostCommand: input.opencode2Host.command, hostEnv: input.opencode2Host.env,
      ...(input.debug ? { debug: input.debug } : {}),
    });
  }
  if ((input.core === 'antigravity' || input.core === 'agy') && input.bridgeDir) {
    const seedInput = { bridgeDir: input.bridgeDir, ...(input.debug ? { debug: input.debug } : {}) };
    const creds = await seedAgyCredentials(seedInput);
    if (!creds.ok) return creds;
    return seedAgyAutonomousState(seedInput);
  }
  return { ok: true };
}
