import { recordClonedWorktree } from '../../agent/clonedWorktree.js';
import type { SandboxMemoryConfig } from '../../agent/docker/dockerMemory.js';
import { disposeFailures } from '../../agent/disposeResult.js';
import { backendCoreKey, backendForCore, type AgentBackends } from '../../agent/backendChoices.js';
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
import { HOST_SESSION_RUNNER, type SandboxProbe, type SessionRunner } from '../../agent/sessionRunner.js';
import type { BridgePaths } from '../../agent/bridge/bridgeDir.js';
import { hostHeadFileFor, readHostHead, recordHostHead } from '../../agent/hostHead.js';
import { DIRTY_NOT_BEHIND, stashMessage } from '../../agent/cloneRefresh.js';
import type { Notify } from './notify.js';
import type { TicketPlacement } from '../../store/placement.js';
import { classifyDivergence, nodeGit } from './sandboxRewrite.js';

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
  readonly sandboxMemory?: SandboxMemoryConfig;
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
    const bridgePaths = input.bridgeFor ? await input.bridgeFor(input.ticketId).catch(() => undefined) : undefined;
    const out = await resolve({
      backends: { ...input.backends, [backendCoreKey(input.core)]: backend, [input.core]: backend }, core: input.core, projectRoot: input.projectRoot, ticketId: input.ticketId,
      ...(bridgePaths?.dir ? { bridgeDir: bridgePaths.dir } : {}),
      ...(input.worktree?.branch ? { worktree: { hostWorktreePath: input.worktree.path, branch: input.worktree.branch } } : {}),
      ...(input.debug || input.hostPorts || input.sandboxMemory ? {
        docker: { ...(input.debug ? { debug: input.debug } : {}), ...(input.hostPorts ? { hostPorts: input.hostPorts } : {}), ...(input.sandboxMemory ? { sandboxMemory: input.sandboxMemory } : {}) },
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
  /** Where this launch runs: what the host records on the ticket (arch:AC-32), including a fail-closed fallback and its reason. */
  readonly placement: TicketPlacement;
  /** The bridge dir as the agent sees it (ends in the ticket id); absent when no bridge is attached. */
  readonly runDir?: string;
  /** Host paths of the attached bridge dir (the mirror target for attachments and gate logs). */
  readonly bridge?: BridgePaths;
}

/**
 * Resolve the launch runner BEFORE the seed is composed: the instructions an
 * agent gets depend on where it runs (a sandbox has no host CLI, db or MCP).
 * Fail-closed fallbacks resolve to the host runner here, so the text always
 * matches the runner that really opens the session.
 */
export async function resolveLaunchBackend(input: BackendSessionInput, remember?: (core: string | null) => void): Promise<LaunchBackend> {
  const options = backendSessionOptions(input);
  if (!options.resolveRunner) return { options, sandboxed: false, placement: { backend: 'host', core: input.core, sandboxName: null, reason: null } };
  const resolved = await options.resolveRunner();
  // Pointer text follows THIS launch's runner (arch:AC-34).
  remember?.(resolved.runner.enforcesSandbox ? input.core : null);
  const handed = { ...options, resolveRunner: () => Promise.resolve(resolved) };
  const placement = placementOfResolved(resolved, input.core);
  if (!resolved.runner.enforcesSandbox) return { options: handed, sandboxed: false, placement };
  if (input.syncExisting && (await resolved.runner.hasSandbox?.())) {
    const synced = await input.syncExisting();
    if (!synced.ok) throw new Error(`Karst: ${input.ticketLabel} sandbox is not in sync with the host branch: ${synced.reason}`);
  }
  const paths = await options.bridgeFor?.(input.ticketId);
  const runDir = paths ? resolved.runner.bridgeRunDir?.(paths) : undefined;
  if (paths && input.worktree) await recordClonedWorktree(paths.dir, input.worktree.path).catch((err) => input.debug?.(`cloned-worktree record failed: ${String(err)}`));
  return { options: handed, sandboxed: true, placement, ...(runDir !== undefined ? { runDir } : {}), ...(paths ? { bridge: paths } : {}) };
}

/** The placement a resolved runner means: its kind, the name inside `sbx (<name>)` / `docker (<name>)`, or the host fallback reason. */
export function placementOfResolved(resolved: ResolvedBackend, core: string): TicketPlacement {
  const inParens = /^\w+ \((.*)\)$/s.exec(resolved.line)?.[1] ?? null;
  const { kind, enforcesSandbox } = resolved.runner;
  if (kind === 'host' || !enforcesSandbox) return { backend: 'host', core, sandboxName: null, reason: inParens };
  return { backend: kind, core, sandboxName: inParens, reason: null };
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
  /** Every sync verdict: is the sandbox's refusal a host rewrite the commits can be carried over? (drives the dashboard action) */
  readonly onRewritten?: (ticketId: number, rewritten: boolean) => void;
  /** The base branch of a recorded merge conflict on this ticket, or null: while one is open every refresh ships `origin/<base>` in the bundle. */
  readonly conflictBaseRef?: (ticketId: number) => string | null;
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
  const probe = await probeOf(runner);
  if (probe.state !== 'present') {
    await deps.notify.error(probe.state === 'unknown' ? `Karst: sandbox sync for ${target.ticketLabel} failed: ${unknownReason(runner, probe)}` : `Karst: ${target.ticketLabel} has no sandbox to sync.`);
    return false;
  }
  const result = await runner.sync({ hostWorktreePath: target.worktree.path, branch: target.worktree.branch });
  if (!result.ok) {
    const rewritten = /not a fast-forward/i.test(result.reason) && (await isRewritten(deps, { path: target.worktree.path, branch: target.worktree.branch, ticketId: target.ticketId }));
    deps.onRewritten?.(target.ticketId, rewritten);
    await deps.notify.error(`Karst: sandbox sync for ${target.ticketLabel} failed: ${result.reason}${rewritten ? ' The host branch was rewritten: use "Carry sandbox commits onto host branch" on the dashboard.' : ''}`);
    return false;
  }
  deps.onRewritten?.(target.ticketId, false);
  await recordSyncedHead(deps, target);
  deps.notify.info(`Karst: ${target.ticketLabel} ${result.summary}.`);
  return true;
}

export type EnsureSyncResult =
  | { readonly ok: true }
  /** `rewritten`: the divergence is a host rebase/amend the sandbox's commits can be carried over (arch:AC-33). */
  | { readonly ok: false; readonly reason: string; readonly diverged: boolean; readonly rewritten?: boolean; /** The sandbox CLI could not answer (PATH, daemon): a blocker no sync diff can help with. */ readonly unknown?: true };

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
export function ensureSandboxInSync(deps: SandboxSyncDeps, target: SandboxSyncTarget, opts: { readonly refresh?: boolean; readonly allowDirtyClone?: boolean } = {}): Promise<EnsureSyncResult> {
  return serialised(target.ticketId, async () => {
    const runner = sandboxRunnerFor(deps, target.core, target.ticketId);
    const probe = runner ? await probeOf(runner) : undefined;
    const synced = await syncStep(deps, target, probe);
    // A host ticket has no sandbox (the guard in syncStep said ok): nothing to refresh either.
    if (!runner || !synced.ok || opts.refresh === false || probe?.state !== 'present') return synced;
    if (!runner.refresh || !target.worktree?.branch) return synced;
    try {
      const refreshed = await runner.refresh({ hostWorktreePath: target.worktree.path, branch: target.worktree.branch }, baseOpts(deps, target.ticketId));
      // Opening a session: uncommitted clone work with nothing to bring in is the user's own to continue, not a blocker.
      if (!refreshed.ok && opts.allowDirtyClone && refreshed.reason.startsWith(DIRTY_NOT_BEHIND)) return { ok: true };
      return refreshed.ok ? { ok: true } : { ok: false, reason: refreshed.reason, diverged: /diverged/i.test(refreshed.reason) };
    } catch (err) {
      return { ok: false, reason: `sandbox refresh failed: ${message(err)}`, diverged: false };
    }
  });
}

export type StashUpdateResult =
  | { readonly ok: true; readonly stash: string }
  | { readonly ok: false; readonly reason: string };

/**
 * The user-clicked recovery for "sandbox has uncommitted work and the host is
 * ahead": sync sandbox → host, then host → sandbox with the clone's dirty tree
 * parked by `git stash push -u` first (named for the ticket and the time, shown
 * and logged so the work is recoverable). Never resets or discards.
 */
export function stashSandboxAndUpdate(deps: SandboxSyncDeps, target: SandboxSyncTarget, now: Date = new Date()): Promise<StashUpdateResult> {
  return serialised(target.ticketId, async (): Promise<StashUpdateResult> => {
    const runner = sandboxRunnerFor(deps, target.core, target.ticketId);
    if (!runner?.refresh || !target.worktree?.branch) return { ok: false, reason: `${target.ticketLabel} has no sandbox to update` };
    const probe = await probeOf(runner);
    if (probe.state === 'unknown') return { ok: false, reason: unknownReason(runner, probe) };
    if (probe.state === 'absent') return { ok: false, reason: `${target.ticketLabel} has no sandbox to update` };
    const synced = await syncStep(deps, target, probe);
    if (!synced.ok) return { ok: false, reason: synced.reason };
    const stash = stashMessage(target.ticketLabel, now);
    try {
      const refreshed = await runner.refresh({ hostWorktreePath: target.worktree.path, branch: target.worktree.branch }, { stashMessage: stash, ...baseOpts(deps, target.ticketId) });
      if (!refreshed.ok) return { ok: false, reason: refreshed.reason };
    } catch (err) {
      return { ok: false, reason: `sandbox refresh failed: ${message(err)}` };
    }
    deps.notify.info(`Karst: ${target.ticketLabel} sandbox updated from the host; any uncommitted sandbox work is in the stash "${stash}" (git stash list, inside the sandbox).`);
    return { ok: true, stash };
  });
}

function baseOpts(deps: SandboxSyncDeps, ticketId: number): { baseRef?: string } {
  const baseRef = deps.conflictBaseRef?.(ticketId);
  return baseRef ? { baseRef } : {};
}

async function syncStep(deps: SandboxSyncDeps, target: SandboxSyncTarget, known?: SandboxProbe): Promise<EnsureSyncResult> {
  const runner = sandboxRunnerFor(deps, target.core, target.ticketId);
  if (!runner?.sync) return { ok: true };
  // The one sync guard: absent = a host ticket (nothing to sync, never spawn the CLI for it);
  // unknown = the CLI cannot say, so a sandboxed ticket's commits must not be skipped (arch:AC-39).
  const probe = known ?? (await probeOf(runner));
  if (probe.state === 'absent') return { ok: true };
  if (probe.state === 'unknown') return { ok: false, reason: unknownReason(runner, probe), diverged: false, unknown: true };
  if (!target.worktree?.branch) return { ok: false, reason: 'no worktree branch to sync into', diverged: false };
  try {
    const result = await runner.sync({ hostWorktreePath: target.worktree.path, branch: target.worktree.branch });
    if (result.ok) {
      deps.onRewritten?.(target.ticketId, false);
      await recordSyncedHead(deps, target);
      return { ok: true };
    }
    const diverged = /not a fast-forward/i.test(result.reason);
    // The failed sync left the clone's branch in FETCH_HEAD, which the classifier reads.
    const rewritten = diverged && (await isRewritten(deps, { path: target.worktree.path, branch: target.worktree.branch, ticketId: target.ticketId }));
    if (diverged) deps.onRewritten?.(target.ticketId, rewritten);
    return { ok: false, reason: result.reason, diverged, ...(rewritten ? { rewritten } : {}) };
  } catch (err) {
    return { ok: false, reason: `sandbox sync failed: ${message(err)}`, diverged: false };
  }
}

/** The runner's tri-state probe; a runner without one falls back to `hasSandbox`, a throw is `unknown`. */
export async function probeOf(runner: SessionRunner): Promise<SandboxProbe> {
  try {
    if (runner.probeSandbox) return await runner.probeSandbox();
    return (await runner.hasSandbox?.()) ? { state: 'present' } : { state: 'absent' };
  } catch (err) {
    return { state: 'unknown', reason: message(err) };
  }
}

function unknownReason(runner: SessionRunner, probe: { readonly reason: string }): string {
  return `${runner.kind} CLI not runnable from the extension host: ${probe.reason}. Its sandbox commits were not synced.`;
}

const SHA = /^[0-9a-f]{40,64}$/;

/** Remember the host branch head a good sync left, outside the mount (arch:AC-34). Advisory: the reflog is the fallback, so a failed write only costs that fallback. */
export async function recordSyncedHead(deps: SandboxSyncDeps, target: SandboxSyncTarget): Promise<void> {
  const dir = deps.evidenceDirOf?.(target.ticketId);
  if (!dir || !target.worktree) return;
  const head = await nodeGit(deps.proc ?? NODE_SBX_PROCESS)(target.worktree.path, ['rev-parse', 'HEAD']);
  const sha = head.stdout.trim();
  if (head.code !== 0 || !SHA.test(sha)) return;
  await recordHostHead(hostHeadFileFor(dir), target.worktree.path, sha).catch(() => undefined);
}

/** Is the refused sync a host rewrite? Needs the clone's branch in FETCH_HEAD of the host worktree. */
export async function isRewritten(deps: SandboxSyncDeps, wt: { path: string; branch: string; ticketId: number }): Promise<boolean> {
  const dir = deps.evidenceDirOf?.(wt.ticketId);
  const recorded = dir ? await readHostHead(hostHeadFileFor(dir), wt.path) : undefined;
  const out = await classifyDivergence(nodeGit(deps.proc ?? NODE_SBX_PROCESS), { worktree: wt.path, branch: wt.branch, recorded });
  return out.kind === 'rewritten';
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
    const removal = await runner.dispose({ hostWorktreePath: target.worktree.path, branch: target.worktree.branch });
    if (!removal.ok) {
      await deps.notify.error(`Karst: removing the sandbox for ${target.ticketLabel} failed (${disposeFailures(removal)}); its evidence dir was kept.`);
      return false;
    }
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
