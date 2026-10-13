import { randomBytes } from 'node:crypto';
import { spawnHeadlessCli } from '../headlessSpawn.js';
import type { PlacedInteractiveLaunch, RunHeadless, SandboxTicketRef, SessionRunner } from '../sessionRunner.js';
import { chownVolumes, ensureClone, ensureVolume, OS_TEMP_DIRS, syncFromClone, type CloneContext, type StepResult, type TempDirs } from './dockerClone.js';
import { seedOpencode2Credentials } from './dockerCredentials.js';
import type { DockerCore } from './dockerImage.js';
import type { DockerNames } from './dockerNames.js';
import { detail, DOCKER_BIN } from './dockerPreflight.js';
import type { DockerProcess } from './dockerProcess.js';
import {
  containerCommand,
  headlessExecArgs,
  headlessKillArgs,
  interactiveRunArgs,
  type LinuxUser,
  rewritePaths,
} from './dockerRunArgs.js';
import { startProxySidecar, stopProxySidecar } from './proxySidecar.js';

export interface DockerRunnerOptions {
  readonly proc: DockerProcess;
  readonly core: DockerCore;
  readonly names: DockerNames;
  readonly user: LinuxUser | undefined;
  /** opencode v1 only: the host `auth.json`, mounted read-only. */
  readonly authFile?: string;
  readonly spawnHeadless?: RunHeadless;
  readonly temp?: TempDirs;
  readonly newRunId?: () => string;
}

/**
 * The plain-docker runner (arch:AC-33, opencode + opencode2). Clone mode: the
 * agent works in a clone on a named volume, behind an `--internal` network
 * whose only exit is the allowlist proxy. Interactive = `docker run -it`,
 * headless = `docker exec` into that container. Never `--privileged`, never
 * the docker socket, argv arrays only, async spawns only.
 */
export function createDockerSessionRunner(opts: DockerRunnerOptions): SessionRunner {
  const spawnHeadless = opts.spawnHeadless ?? spawnHeadlessCli;
  const newRunId = opts.newRunId ?? (() => randomBytes(8).toString('hex'));
  const ctx: CloneContext = { proc: opts.proc, names: opts.names, user: opts.user, temp: opts.temp ?? OS_TEMP_DIRS };
  return {
    kind: 'docker',
    enforcesSandbox: true,
    placeInteractive: (spec): PlacedInteractiveLaunch => ({
      cwd: spec.hostWorktreePath,
      shellPath: DOCKER_BIN,
      shellArgs: interactiveRunArgs({
        names: opts.names, core: opts.core, user: opts.user, authFile: opts.authFile,
        hostWorktreePath: spec.hostWorktreePath, args: spec.args, env: spec.env,
      }),
      env: { ...spec.env },
    }),
    runHeadless: async (command, args, cwd, headlessOpts) => {
      const runId = newRunId();
      // Killing the `docker exec` client leaves the process running in the
      // container; an abort also kills it there, by its recorded pid.
      // A timeout inside spawnHeadless kills only the client too, so the
      // kill (a no-op once the process exited; it also drops the pid file)
      // always runs when the run ends.
      const kill = () => opts.proc.run(DOCKER_BIN, headlessKillArgs(opts.names.container, runId));
      const onAbort = () => void kill();
      headlessOpts?.signal?.addEventListener('abort', onAbort, { once: true });
      try {
        const argv = headlessExecArgs(opts.names.container, runId, containerCommand(opts.core, command), rewritePaths(args, cwd));
        return await spawnHeadless(DOCKER_BIN, argv, cwd, headlessOpts);
      } finally {
        headlessOpts?.signal?.removeEventListener('abort', onAbort);
        await kill();
      }
    },
    sync: (ticket: SandboxTicketRef) => syncFromClone(ctx, ticket),
    dispose: async (): Promise<void> => {
      const n = opts.names;
      await opts.proc.run(DOCKER_BIN, ['rm', '--force', n.container]);
      await stopProxySidecar(opts.proc, n.proxy);
      await opts.proc.run(DOCKER_BIN, ['network', 'rm', n.network]);
      await opts.proc.run(DOCKER_BIN, ['volume', 'rm', '--force', n.repoVolume, n.dataVolume]);
    },
  };
}

export interface PrepareInput {
  readonly proc: DockerProcess;
  readonly core: DockerCore;
  readonly names: DockerNames;
  readonly user: LinuxUser | undefined;
  readonly ticket: SandboxTicketRef;
  /** Host path of the bundled proxy script. */
  readonly proxyScript: string;
  /** opencode2 only: how to read the host's karst-isolated credential store. */
  readonly opencode2Host?: { readonly command: string; readonly env: Readonly<Record<string, string>> };
  readonly temp?: TempDirs;
  readonly debug?: (message: string) => void;
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
  const proxy = await startProxySidecar(proc, { proxy: names.proxy, network: names.network, scriptPath: input.proxyScript });
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
    clone = await ensureClone(ctx, { hostWorktreePath: input.ticket.hostWorktreePath, branch: input.ticket.branch });
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
  return { ok: true };
}
