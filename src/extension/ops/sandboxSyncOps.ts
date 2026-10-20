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
  /**
   * F8: before a session starts or resumes in a sandbox that already exists, sync sandbox → host
   * and refresh host → sandbox. A blocker (dirty clone, divergence) stops the launch.
   */
  readonly syncExisting?: () => Promise<EnsureSyncResult>;
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

export interface LaunchBackend {
  /** The `openSession` options; a resolved runner is handed over as is so the session does not resolve (and prepare) it twice. */
  readonly options: ReturnType<typeof backendSessionOptions>;
  /** The runner enforces a sandbox: compose sandbox instructions, not the host CLI ones. */
  readonly sandboxed: boolean;
  /** The bridge dir as the agent sees it (ends in the ticket id); absent when no bridge is attached. */
  readonly runDir?: string;
}

/**
 * Resolve the launch runner BEFORE the seed is composed: the instructions an
 * agent gets depend on where it runs (a sandbox has no host CLI, db or MCP).
 * Fail-closed fallbacks resolve to the host runner here, so the text always
 * matches the runner that really opens the session.
 */
export async function resolveLaunchBackend(input: BackendSessionInput, remember?: (core: string | null) => void): Promise<LaunchBackend> {
  const options = backendSessionOptions(input);
  if (!options.resolveRunner) return { options, sandboxed: false };
  const resolved = await options.resolveRunner();
  // Pointer text follows THIS launch's runner (arch:AC-34).
  remember?.(resolved.runner.enforcesSandbox ? input.core : null);
  const handed = { ...options, resolveRunner: () => Promise.resolve(resolved) };
  if (!resolved.runner.enforcesSandbox) return { options: handed, sandboxed: false };
  if (input.syncExisting && (await resolved.runner.hasSandbox?.())) {
    const synced = await input.syncExisting();
    if (!synced.ok) throw new Error(`Karst: ${input.ticketLabel} sandbox is not in sync with the host branch: ${synced.reason}`);
  }
  const paths = await options.bridgeFor?.(input.ticketId);
  const runDir = paths ? resolved.runner.bridgeRunDir?.(paths) : undefined;
  return { options: handed, sandboxed: true, ...(runDir !== undefined ? { runDir } : {}) };
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
  /** The bridge dir as the host sees it: sbx hands the host's bundle to the sandbox through its `xfer/` (F8). */
  readonly evidenceDirOf?: (ticketId: number) => string | undefined;
}

/** The sandbox runner that holds a core's clone: sbx (claude, codex) or docker (opencode, opencode2). */
export function sandboxRunnerFor(deps: SandboxSyncDeps, core: string | null, ticketId: number): SessionRunner | undefined {
  if (isSbxCore(core)) {
    const name = sbxName({ projectRoot: deps.projectRoot, ticketId, core });
    const evidenceDir = deps.evidenceDirOf?.(ticketId);
    return createSbxSessionRunner({ proc: deps.proc ?? NODE_SBX_PROCESS, core, name, existing: [], cloneDir: sbxCloneDir(deps.projectRoot, name), ...(evidenceDir ? { evidenceDir } : {}) });
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
  return serialised(target.ticketId, () => syncStep(deps, target));
}

/**
 * Both directions before a host step that gates or hands the tree to another
 * agent (F8/F12): sandbox → host (ff-only), then host → sandbox. A dirty clone
 * or divergence is a blocker (`ok:false`), never an overwrite.
 */
export function ensureSandboxInSync(deps: SandboxSyncDeps, target: SandboxSyncTarget, opts: { readonly refresh?: boolean } = {}): Promise<EnsureSyncResult> {
  return serialised(target.ticketId, async () => {
    const runner = sandboxRunnerFor(deps, target.core, target.ticketId);
    // A host ticket in a sandbox-configured project has no sandbox: nothing to sync.
    if (!runner || !(await runner.hasSandbox?.().catch(() => false))) return { ok: true };
    const synced = await syncStep(deps, target);
    if (!synced.ok || opts.refresh === false) return synced;
    if (!runner.refresh || !target.worktree?.branch) return synced;
    try {
      const refreshed = await runner.refresh({ hostWorktreePath: target.worktree.path, branch: target.worktree.branch });
      return refreshed.ok ? { ok: true } : { ok: false, reason: refreshed.reason, diverged: /diverged/i.test(refreshed.reason) };
    } catch (err) {
      return { ok: false, reason: `sandbox refresh failed: ${message(err)}`, diverged: false };
    }
  });
}

async function syncStep(deps: SandboxSyncDeps, target: SandboxSyncTarget): Promise<EnsureSyncResult> {
  const runner = sandboxRunnerFor(deps, target.core, target.ticketId);
  if (!runner?.sync) return { ok: true };
  if (!target.worktree?.branch) return { ok: false, reason: 'no worktree branch to sync into', diverged: false };
  try {
    const result = await runner.sync({ hostWorktreePath: target.worktree.path, branch: target.worktree.branch });
    return result.ok ? { ok: true } : { ok: false, reason: result.reason, diverged: /not a fast-forward/i.test(result.reason) };
  } catch (err) {
    return { ok: false, reason: `sandbox sync failed: ${message(err)}`, diverged: false };
  }
}

function serialised<T>(ticketId: number, run: () => Promise<T>): Promise<T> {
  const next = (syncChains.get(ticketId) ?? Promise.resolve()).then(run, run);
  const settled = next.then(() => undefined, () => undefined);
  syncChains.set(ticketId, settled);
  void settled.then(() => { if (syncChains.get(ticketId) === settled) syncChains.delete(ticketId); });
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
