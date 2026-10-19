import { backendForCore, type AgentBackends } from '../../agent/backendChoices.js';
import { resolveBackend, type ResolvedBackend } from '../../agent/backendResolver.js';
import { ticketBackendSetting } from '../../agent/effectiveBackend.js';
import { sbxName } from '../../agent/sbx/sbxName.js';
import { NODE_SBX_PROCESS, type SbxProcess } from '../../agent/sbx/sbxProcess.js';
import { sbxCloneDir } from '../../agent/sbx/sbxClone.js';
import { createSbxSessionRunner, SBX_CORES, type SbxCore } from '../../agent/sbx/sbxRunner.js';
import type { TempDirs } from '../../agent/docker/dockerClone.js';
import { isDockerCore } from '../../agent/docker/dockerImage.js';
import { dockerNames } from '../../agent/docker/dockerNames.js';
import { NODE_DOCKER_PROCESS, type DockerProcess } from '../../agent/docker/dockerProcess.js';
import { createDockerSessionRunner } from '../../agent/docker/dockerRunner.js';
import { linuxUser } from '../../agent/docker/resolveDocker.js';
import { HOST_SESSION_RUNNER, type SessionRunner } from '../../agent/sessionRunner.js';
import type { BridgePaths } from '../../agent/bridge/bridgeDir.js';
import type { Notify } from './notify.js';

export { createTicketSandboxBindings, withSandboxSpin } from './sandboxTicketOps.js';

export interface BackendSessionInput {
  readonly backends: AgentBackends | undefined;
  /** The ticket's opt-out (`tickets.agent_backend`); it can only select host, never a backend. */
  readonly ticketOverride?: 'host' | null;
  /** Shown to the user when a chosen sandbox backend fell back to a prompted host session. */
  readonly warn?: (message: string) => void;
  readonly core: string;
  readonly projectRoot: string;
  readonly ticketId: number;
  readonly ticketLabel: string;
  readonly info: (line: string) => void;
  /** The ticket worktree; the docker backend clones its branch. */
  readonly worktree?: { readonly path: string; readonly branch: string | null };
  /** How many repos' worktrees the ticket has; more than one never gets a sandbox in v1 (decided at launch). */
  readonly worktreeCount?: number;
  readonly debug?: (message: string) => void;
  readonly resolve?: typeof resolveBackend;
  /** Attaches the ticket's evidence bridge; `openSession` calls it only for a sandbox runner (arch:AC-34). */
  readonly bridgeFor?: (ticketId: number) => Promise<BridgePaths>;
  /** Baseline host ports the docker proxy lets the sandbox reach (arch:AC-32); sbx applies them on reattach. */
  readonly hostPorts?: readonly number[];
}

/**
 * The `openSession` options for the manifest's `agentBackends` entry of the session core (arch:AC-32).
 * Absent → no options at all, so a host launch is byte-identical to before.
 */
export function backendSessionOptions(input: BackendSessionInput): {
  resolveRunner?: () => Promise<ResolvedBackend>;
  onBackend?: (line: string) => void;
  bridgeFor?: (ticketId: number) => Promise<BridgePaths>;
} {
  // The project owns whether the feature is on: a ticket opt-out alone changes nothing.
  if (input.backends === undefined) return {};
  const backend = ticketBackendSetting(backendForCore(input.backends, input.core), input.ticketOverride)!;
  // v1: a multi-repo ticket starts as a normal host session from the beginning (host prompts as usual; arch:AC-31 host mode).
  if (backend !== 'host' && (input.worktreeCount ?? 1) > 1) {
    return { onBackend: (line) => input.info(`[session] ticket ${input.ticketLabel} backend: ${line}`), resolveRunner: () => Promise.resolve({ runner: HOST_SESSION_RUNNER, line: 'host (multi-repo ticket: no sandbox in v1)' }) };
  }
  const resolve = input.resolve ?? resolveBackend;
  const resolveRunner = async (): Promise<ResolvedBackend> => {
    const out = await resolve({
      backends: { ...input.backends, [input.core]: backend }, core: input.core, projectRoot: input.projectRoot, ticketId: input.ticketId,
      ...(input.worktree?.branch ? { worktree: { hostWorktreePath: input.worktree.path, branch: input.worktree.branch } } : {}),
      ...(input.debug || input.hostPorts ? {
        docker: { ...(input.debug ? { debug: input.debug } : {}), ...(input.hostPorts ? { hostPorts: input.hostPorts } : {}) },
      } : {}),
    });
    // The fail-closed fallback is never silent (arch:AC-31): say why it runs prompted.
    if (backend !== 'host' && out.runner.kind === 'host') input.warn?.(`Karst: ${input.ticketLabel} running prompted on host: ${fallbackReason(out.line)}`);
    return out;
  };
  return {
    resolveRunner,
    onBackend: (line) => input.info(`[session] ticket ${input.ticketLabel} backend: ${line}`),
    ...(input.bridgeFor ? { bridgeFor: input.bridgeFor } : {}),
  };
}

/** `host (<reason>)` → `<reason>`. */
function fallbackReason(line: string): string {
  const m = /^host \((.*)\)$/s.exec(line);
  return m ? m[1]! : line;
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
export function sandboxRunnerFor(deps: SandboxSyncDeps, core: string | null, ticketId: number): SessionRunner | undefined {
  if (isSbxCore(core)) {
    const name = sbxName({ projectRoot: deps.projectRoot, ticketId, core });
    return createSbxSessionRunner({ proc: deps.proc ?? NODE_SBX_PROCESS, core, name, existing: [], cloneDir: sbxCloneDir(deps.projectRoot, name) });
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

export type EnsureSyncResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string; readonly diverged: boolean };

const syncChains = new Map<number, Promise<unknown>>();

/**
 * THE choke point before any host step that reads a sandboxed ticket's
 * worktree (done marker, stop, close; arch:AC-32): fast-forward the host
 * branch to the sandbox's commits, never forced. A host ticket (no sandbox
 * runner) is a no-op. Serialised per ticket. `diverged` = the host branch
 * is not an ancestor of the sandbox's: the only case that needs the user.
 */
export function ensureSandboxSynced(deps: SandboxSyncDeps, target: SandboxSyncTarget): Promise<EnsureSyncResult> {
  const run = async (): Promise<EnsureSyncResult> => {
    const runner = sandboxRunnerFor(deps, target.core, target.ticketId);
    if (!runner?.sync) return { ok: true };
    if (!target.worktree?.branch) return { ok: false, reason: 'no worktree branch to sync into', diverged: false };
    try {
      const result = await runner.sync({ hostWorktreePath: target.worktree.path, branch: target.worktree.branch });
      return result.ok ? { ok: true } : { ok: false, reason: result.reason, diverged: /not a fast-forward/i.test(result.reason) };
    } catch (err) {
      return { ok: false, reason: `sandbox sync failed: ${message(err)}`, diverged: false };
    }
  };
  const next = (syncChains.get(target.ticketId) ?? Promise.resolve()).then(run, run);
  const settled = next.then(() => undefined, () => undefined);
  syncChains.set(target.ticketId, settled);
  void settled.then(() => { if (syncChains.get(target.ticketId) === settled) syncChains.delete(target.ticketId); });
  return next;
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
