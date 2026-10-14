import type { AgentBackend } from '../../manifest/types.js';
import { resolveBackend, type ResolvedBackend } from '../../agent/backendResolver.js';
import { sbxName } from '../../agent/sbx/sbxName.js';
import { NODE_SBX_PROCESS, type SbxProcess } from '../../agent/sbx/sbxProcess.js';
import { createSbxSessionRunner, SBX_CORES, type SbxCore } from '../../agent/sbx/sbxRunner.js';
import type { TempDirs } from '../../agent/docker/dockerClone.js';
import { isDockerCore } from '../../agent/docker/dockerImage.js';
import { dockerNames } from '../../agent/docker/dockerNames.js';
import { NODE_DOCKER_PROCESS, type DockerProcess } from '../../agent/docker/dockerProcess.js';
import { createDockerSessionRunner } from '../../agent/docker/dockerRunner.js';
import { linuxUser } from '../../agent/docker/resolveDocker.js';
import type { SessionRunner } from '../../agent/sessionRunner.js';
import type { BridgePaths } from '../../agent/bridge/bridgeDir.js';
import type { Notify } from './notify.js';

export interface BackendSessionInput {
  readonly backend: AgentBackend | undefined;
  readonly core: string;
  readonly projectRoot: string;
  readonly ticketId: number;
  readonly ticketLabel: string;
  readonly info: (line: string) => void;
  /** The ticket worktree; the docker backend clones its branch. */
  readonly worktree?: { readonly path: string; readonly branch: string | null };
  readonly debug?: (message: string) => void;
  readonly resolve?: typeof resolveBackend;
  /** Attaches the ticket's evidence bridge; `openSession` calls it only for a sandbox runner (arch:AC-34). */
  readonly bridgeFor?: (ticketId: number) => Promise<BridgePaths>;
}

/**
 * The `openSession` options for the manifest's `agentBackend` (arch:AC-32).
 * Absent → no options at all, so a host launch is byte-identical to before.
 */
export function backendSessionOptions(input: BackendSessionInput): {
  resolveRunner?: () => Promise<ResolvedBackend>;
  onBackend?: (line: string) => void;
  bridgeFor?: (ticketId: number) => Promise<BridgePaths>;
} {
  if (input.backend === undefined) return {};
  const resolve = input.resolve ?? resolveBackend;
  return {
    resolveRunner: () =>
      resolve({
        backend: input.backend, core: input.core, projectRoot: input.projectRoot, ticketId: input.ticketId,
        ...(input.worktree?.branch ? { worktree: { hostWorktreePath: input.worktree.path, branch: input.worktree.branch } } : {}),
        ...(input.debug ? { docker: { debug: input.debug } } : {}),
      }),
    onBackend: (line) => input.info(`[session] ticket ${input.ticketLabel} backend: ${line}`),
    ...(input.bridgeFor ? { bridgeFor: input.bridgeFor } : {}),
  };
}

export interface SandboxSyncTarget {
  readonly ticketId: number;
  readonly ticketLabel: string;
  /** The core that ran the session (the ticket's session provider). */
  readonly core: string | null;
  readonly worktree: { readonly path: string; readonly branch: string | null } | undefined;
}

export interface SandboxSyncDeps {
  readonly notify: Notify;
  readonly projectRoot: string;
  readonly proc?: SbxProcess;
  readonly dockerProc?: DockerProcess;
  readonly temp?: TempDirs;
  readonly platform?: NodeJS.Platform;
}

/** The sandbox runner that holds a core's clone: sbx (claude, codex) or docker (opencode, opencode2). */
function sandboxRunnerFor(deps: SandboxSyncDeps, core: string | null, ticketId: number): SessionRunner | undefined {
  if (isSbxCore(core)) {
    const name = sbxName({ projectRoot: deps.projectRoot, ticketId, core });
    return createSbxSessionRunner({ proc: deps.proc ?? NODE_SBX_PROCESS, core, name, existing: [] });
  }
  if (core !== null && isDockerCore(core)) {
    return createDockerSessionRunner({
      proc: deps.dockerProc ?? NODE_DOCKER_PROCESS,
      core,
      names: dockerNames({ projectRoot: deps.projectRoot, ticketId, core }),
      user: linuxUser(deps.platform ?? process.platform, process.getuid?.(), process.getgid?.()),
      ...(deps.temp ? { temp: deps.temp } : {}),
    });
  }
  return undefined;
}

/**
 * `karst.sandbox.sync`: fast-forward the ticket branch in the host worktree to
 * the sandbox's commits (clone mode). A non-fast-forward is refused and
 * reported, never forced.
 */
export async function syncSandboxOp(deps: SandboxSyncDeps, target: SandboxSyncTarget): Promise<boolean> {
  if (!target.worktree?.branch) {
    await deps.notify.error(`Karst: ${target.ticketLabel} has no worktree branch to sync into.`);
    return false;
  }
  const runner = sandboxRunnerFor(deps, target.core, target.ticketId);
  if (!runner?.sync) {
    await deps.notify.error(`Karst: ${target.ticketLabel} has no sandbox (core ${target.core ?? 'unknown'}).`);
    return false;
  }
  const result = await runner.sync({ hostWorktreePath: target.worktree.path, branch: target.worktree.branch });
  if (!result.ok) {
    await deps.notify.error(`Karst: sandbox sync for ${target.ticketLabel} failed: ${result.reason}`);
    return false;
  }
  deps.notify.info(`Karst: ${target.ticketLabel} ${result.summary}.`);
  return true;
}

export interface SandboxDisposeDeps extends SandboxSyncDeps {
  /** The ticket's evidence bridge (arch:AC-34): removed only after the sandbox is. */
  /** `undefined` until the hook endpoint is bound (activation still running). */
  readonly bridges: { dispose(ticketId: number): Promise<void> } | undefined;
}

/**
 * `karst.sandbox.dispose`: remove the ticket's sandbox, then its bridge dir.
 * A failed removal keeps the dir, so a retry never leaves a sandbox without one.
 */
export async function disposeSandboxOp(deps: SandboxDisposeDeps, target: SandboxSyncTarget): Promise<boolean> {
  const bridges = deps.bridges;
  if (!bridges) {
    await deps.notify.error(`Karst: cannot remove the sandbox for ${target.ticketLabel} yet: the hook endpoint is still starting. Try again.`);
    return false;
  }
  if (!target.worktree?.branch) {
    await deps.notify.error(`Karst: ${target.ticketLabel} has no worktree branch.`);
    return false;
  }
  const runner = sandboxRunnerFor(deps, target.core, target.ticketId);
  if (!runner?.dispose) {
    await deps.notify.error(`Karst: ${target.ticketLabel} has no sandbox (core ${target.core ?? 'unknown'}).`);
    return false;
  }
  try {
    await runner.dispose({ hostWorktreePath: target.worktree.path, branch: target.worktree.branch });
  } catch (err) {
    await deps.notify.error(`Karst: removing the sandbox for ${target.ticketLabel} failed: ${message(err)}`);
    return false;
  }
  try {
    await bridges.dispose(target.ticketId);
  } catch (err) {
    await deps.notify.error(`Karst: ${target.ticketLabel} sandbox removed, but its evidence dir was not: ${message(err)}`);
    return false;
  }
  deps.notify.info(`Karst: ${target.ticketLabel} sandbox removed.`);
  return true;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isSbxCore(core: string | null): core is SbxCore {
  return core !== null && (SBX_CORES as readonly string[]).includes(core);
}
