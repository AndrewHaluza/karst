import { recordClonedWorktree } from '../../agent/clonedWorktree.js';
import type { SandboxMemoryConfig } from '../../agent/docker/dockerMemory.js';
import type { SandboxLimitsConfig } from '../../agent/sbx/sbxLimits.js';
import { disposeFailures } from '../../agent/disposeResult.js';
import { backendCoreKey, backendForCore, type AgentBackends } from '../../agent/backendChoices.js';
import { accountForLaunch } from '../../agent/accounts/registry.js';
import { resolveBackend, type ResolveBackendInput, type ResolvedBackend } from '../../agent/backendResolver.js';
import { ticketBackendSetting } from '../../agent/effectiveBackend.js';
import { sbxName } from '../../agent/sbx/sbxName.js';
import { NODE_SBX_PROCESS, type SbxProcess } from '../../agent/sbx/sbxProcess.js';
import { sbxCloneDir } from '../../agent/sbx/sbxClone.js';
import { createSbxSessionRunner, SBX_CORES, type SbxCore } from '../../agent/sbx/sbxRunner.js';
import type { TempDirs } from '../../agent/docker/dockerClone.js';
import type { RemoteDef } from '../../manifest/types.js';
import { isDockerCore } from '../../agent/docker/dockerImage.js';
import { dockerNames } from '../../agent/docker/dockerNames.js';
import { NODE_DOCKER_PROCESS, type DockerProcess } from '../../agent/docker/dockerProcess.js';
import { createDockerSessionRunner } from '../../agent/docker/dockerRunner.js';
import { linuxUser } from '../../agent/docker/resolveDocker.js';
import { HOST_SESSION_RUNNER, type SandboxProbe, type SessionRunner } from '../../agent/sessionRunner.js';
import type { BridgePaths } from '../../agent/bridge/bridgeDir.js';
import { hostHeadFileFor, readHostHead, recordHostHead } from '../../agent/hostHead.js';
import { isDirtyNotBehind, stashMessage } from '../../agent/cloneRefresh.js';
import type { Notify } from './notify.js';
import { reasonText } from '../../model/notifyText.js';
import type { TicketPlacement } from '../../store/placement.js';
import type { SbxOauthGrants } from '../../agent/sbx/sbxOauthGuest.js';
import { classifyDivergence, nodeGit } from './sandboxRewrite.js';
import { sshRunnerFor, type SshRunnerDeps } from './sshRunnerFor.js';

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
  readonly worktree?: { readonly path: string; readonly branch: string | null; readonly baseRef?: string | null };
  /** How many repos' worktrees the ticket has; more than one never gets a sandbox in v1 (decided at launch). */
  readonly worktreeCount?: number;
  readonly debug?: (message: string) => void;
  /** The session this launch resumes: the sandbox account check uses its RECORDED account (@arch:AC-55). */
  readonly resumeSessionId?: string;
  /** An explicit launch account (a fresh start under `default`); wins over the resumed session's account (@arch:AC-55). */
  readonly account?: string;
  readonly resolve?: typeof resolveBackend;
  /** The host OAuth proxy side of an sbx claude launch, read at each resolve so a token added a moment ago counts (@arch:AC-51). */
  readonly oauth?: () => Promise<NonNullable<ResolveBackendInput['oauth']>>;
  /**
   * Whether the host trust record allows an ssh remote (T1387). Built from
   * `readRemoteTrust` + `isRemoteTrusted`; absent fails closed to "not confirmed".
   */
  readonly remoteTrust?: (name: string) => boolean;
  /** The manifest's `remotes`: an `ssh:<name>` backend is looked up here (D555). */
  readonly remotes?: Readonly<Record<string, RemoteDef>>;
  /** The per-install id (`ssh/install-id`) that salts the remote sandbox name (D555). */
  readonly installId?: string;
  /** Attaches the ticket's evidence bridge; `openSession` calls it only for a sandbox runner (arch:AC-34). */
  readonly bridgeFor?: (ticketId: number) => Promise<BridgePaths>;
  /** Baseline host ports the docker proxy lets the sandbox reach (arch:AC-32); sbx applies them on reattach. */
  readonly hostPorts?: readonly number[];
  readonly sandboxMemory?: SandboxMemoryConfig;
  readonly sandboxLimits?: SandboxLimitsConfig;
  /**
   * F8: before a session starts or resumes in a sandbox that already exists, sync sandbox → host
   * and refresh host → sandbox. A blocker (dirty clone, divergence) stops the launch.
   * It gets the resolved launch runner: on a first launch no placement is recorded yet,
   * so the sync must use this runner, not one picked from the core (D826).
   */
  readonly syncExisting?: (runner: SessionRunner) => Promise<EnsureSyncResult>;
}

/**
 * The `openSession` options for the manifest's `agentBackends` entry of the session core (arch:AC-32).
 * Absent → no options at all, so a host launch is byte-identical to before.
 */
/** The account for the sandbox check: the explicit one, else the resumed session's; none for a new launch (the active account). */
function accountFor(core: string, resume: string | undefined, explicit?: string): { account?: string } {
  const account = accountForLaunch(core, resume, explicit);
  return account === undefined ? {} : { account };
}

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
    const oauth = input.oauth ? await input.oauth() : undefined;
    const out = await resolve({
      ...(oauth ? { oauth } : {}),
      remoteTrusted: input.remoteTrust ?? (() => false),
      ...(input.remotes ? { remotes: input.remotes } : {}),
      ...(input.installId !== undefined ? { installId: input.installId } : {}),
      backends: { ...input.backends, [backendCoreKey(input.core)]: backend, [input.core]: backend }, core: input.core, projectRoot: input.projectRoot, ticketId: input.ticketId,
      ...accountFor(input.core, input.resumeSessionId, input.account),
      ...(bridgePaths?.dir ? { bridgeDir: bridgePaths.dir } : {}),
      ...(input.debug ? { log: input.debug } : {}),
      ...(input.sandboxMemory ? { sandboxMemory: input.sandboxMemory } : {}),
      ...(input.sandboxLimits ? { sandboxLimits: input.sandboxLimits } : {}),
      ...(input.worktree?.branch ? { worktree: { hostWorktreePath: input.worktree.path, branch: input.worktree.branch, ...(input.worktree.baseRef ? { baseRef: input.worktree.baseRef } : {}) } } : {}),
      ...(input.debug || input.hostPorts || input.sandboxMemory ? {
        docker: { ...(input.debug ? { debug: input.debug } : {}), ...(input.hostPorts ? { hostPorts: input.hostPorts } : {}), ...(input.sandboxMemory ? { sandboxMemory: input.sandboxMemory } : {}) },
      } : {}),
    });
    // The fail-closed fallback is never silent (arch:AC-31): say why it runs prompted.
    // A typed account block is not a fallback: the launch asks (or refuses) instead of running on the host.
    if (backend !== 'host' && out.runner.kind === 'host' && !out.blocked) input.warn?.(`${input.ticketLabel} runs prompted on the host: ${fallbackReason(out.line)}`);
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
  /**
   * The launch runs OFF the host (`runner.kind !== 'host'`): a sandbox or an
   * ssh remote. Host-path channels (CLI seed, MCP, host services, the host
   * worktree materialization) are unavailable there. NOT autonomy: that stays
   * `runner.enforcesSandbox` (`@arch:AC-31`, a direct ssh launch is prompted).
   */
  readonly sandboxed: boolean;
  /** Where this launch runs: what the host records on the ticket (arch:AC-32), including a fail-closed fallback and its reason. */
  readonly placement: TicketPlacement;
  /** The sandbox backend refused the launch account: the runner is the host, and the launch must ask before it uses it. */
  readonly blocked?: ResolvedBackend['blocked'];
  /** The bridge dir as the agent sees it (ends in the ticket id); absent when no bridge is attached. */
  readonly runDir?: string;
  /** Host paths of the attached bridge dir (the mirror target for attachments and gate logs). */
  readonly bridge?: BridgePaths;
  /** Links the sandbox transcripts into the bridge dir. Run it after the bounded backend step, never inside it: `sbx create` can be slow. */
  readonly linkTranscripts?: () => Promise<void>;
  /** Gives the proxy key of this launch back; for a backend result that arrives after its timeout and is never launched. */
  readonly abortLaunch?: () => Promise<void>;
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
  // Non-blocking warnings of the step (the no-tmux one): the launch notification shows them.
  for (const warning of resolved.warnings ?? []) input.warn?.(warning);
  // The launch runs off the host: a sandbox OR an ssh remote (D555, `@arch:AC-31`).
  const offHost = resolved.runner.kind !== 'host';
  // Pointer text follows THIS launch's runner (arch:AC-34).
  remember?.(offHost ? input.core : null);
  const handed = { ...options, resolveRunner: () => Promise.resolve(resolved) };
  const placement = placementOfResolved(resolved, input.core);
  if (!offHost) return { options: handed, sandboxed: false, placement, ...(resolved.blocked ? { blocked: resolved.blocked } : {}) };
  const existing = resolved.runner.ensureWritable ? await resolved.runner.hasSandbox?.() : false;
  if (existing) {
    const writable = await resolved.runner.ensureWritable!(input.worktree?.branch ? { hostWorktreePath: input.worktree.path, branch: input.worktree.branch } : undefined);
    if (!writable.ok) throw new Error(`${input.ticketLabel}: ${writable.reason}`);
    const branch = input.worktree?.branch;
    if (branch && resolved.runner.ensureCloneReady) {
      const ready = await resolved.runner.ensureCloneReady(branch);
      if (!ready.ok) throw new Error(`${input.ticketLabel}: ${ready.reason}`);
    }
  }
  const ticketRef = input.worktree
    ? { hostWorktreePath: input.worktree.path, branch: input.worktree.branch ?? '', ...(input.worktree.baseRef ? { baseRef: input.worktree.baseRef } : {}) }
    : undefined;
  // sbx claude through the host proxy: a new key per launch, the policy rule and the key approval (@arch:AC-51).
  // A launch that stops after the key is issued gives the key back: no key outlives a failed launch.
  try {
    const prepared = await resolved.runner.prepareLaunch?.();
    if (prepared && !prepared.ok) throw new Error(`${input.ticketLabel}: ${prepared.reason}`);
    // Every off-host runner (sbx, docker, ssh) syncs an existing clone the same way (D826).
    if (input.syncExisting && (await resolved.runner.hasSandbox?.())) {
      const synced = await input.syncExisting(resolved.runner);
      if (!synced.ok) throw new Error(`${input.ticketLabel}: the sandbox is not in sync with the host branch: ${synced.reason}`);
    }
    const paths = await options.bridgeFor?.(input.ticketId);
    const runDir = paths ? resolved.runner.bridgeRunDir?.(paths) : undefined;
    if (paths && input.worktree) await recordClonedWorktree(paths.dir, input.worktree.path).catch((err) => input.debug?.(`cloned-worktree record failed: ${String(err)}`));
    const canLink = Boolean(paths && input.worktree);
    // The guest setup of a new sandbox runs in the link step: without a bridge it could not run, and the launch would fail later without a reason.
    if (!canLink && resolved.runner.guestSetupPending?.()) throw new Error(`${input.ticketLabel}: the launch stops. The proxy key of a new sandbox needs a bridge and a worktree to be set up.`);
    const link = paths && input.worktree ? transcriptLinkStep(resolved.runner, input, paths.dir, input.worktree.path) : undefined;
    return { options: handed, sandboxed: true, placement, ...(runDir !== undefined ? { runDir } : {}), ...(paths ? { bridge: paths } : {}), ...(link ? { linkTranscripts: link } : {}), ...(resolved.runner.abortLaunch ? { abortLaunch: () => resolved.runner.abortLaunch!() } : {}) };
  } catch (err) {
    await resolved.runner.abortLaunch?.().catch(() => undefined);
    throw err;
  }
}

/**
 * The transcript link step, handed back instead of run: `sbx create` may be slow, and the
 * bounded backend step (180 s) must not stop a launch for it. A failure only logs (arch:AC-34).
 */
function transcriptLinkStep(runner: SessionRunner, input: BackendSessionInput, bridgeDir: string, hostWorktreePath: string): (() => Promise<void>) | undefined {
  if (!runner.linkTranscripts) return undefined;
  const link = runner.linkTranscripts.bind(runner);
  return async () => {
    // A missing token count must not stop a session: a failed link is only a warning.
    const linked = await link({ bridgeDir, hostWorktreePath })
      .catch((err: unknown) => ({ ok: false as const, reason: err instanceof Error ? err.message : String(err) }));
    // A failed guest setup is no transcript problem: the launch stops with its own reason, before `placeInteractive` fails without one.
    if (!linked.ok && runner.guestSetupPending?.()) {
      await runner.abortLaunch?.().catch(() => undefined);
      throw new Error(`${input.ticketLabel}: ${linked.reason}`);
    }
    if (!linked.ok) input.info(`warning: ${input.ticketLabel}: sandbox transcripts are not linked, token usage will not be counted: ${linked.reason}`);
  };
}

/** The placement a resolved runner means: its kind, the name inside `sbx (<name>)` / `docker (<name>)` / `ssh (<remote>/<name>)`, or the host fallback reason. */
export function placementOfResolved(resolved: ResolvedBackend, core: string): TicketPlacement {
  const inParens = /^\w+ \((.*)\)$/s.exec(resolved.line)?.[1] ?? null;
  const { kind } = resolved.runner;
  // Placement is where it runs; autonomy is `enforcesSandbox` (@arch:AC-31).
  if (kind === 'host') return { backend: 'host', core, sandboxName: null, reason: inParens };
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
  /** The bare ticket key for a terminal name; `ticketLabel` is the longer toast name. */
  readonly ticketKey?: string;
  /** The core that ran the session (the ticket's session provider). */
  readonly core: string | null;
  readonly worktree: { readonly path: string; readonly branch: string | null } | undefined;
}

export interface SandboxSyncDeps {
  readonly notify: Notify;
  readonly projectRoot: string;
  readonly proc?: SbxProcess;
  readonly dockerProc?: DockerProcess;
  /** The sbx memory ceiling, so a runner built here can name it in an OOM report. */
  readonly sbxMemory?: () => string | undefined;
  /**
   * The proxy grants: a runner built here revokes the key of its sandbox at dispose (@arch:AC-51).
   *
   * A PROVIDER, not the value: the grants are read at the point of use, so no
   * credential sits on the deps bag that also carries `projectRoot` (the naming
   * hash reads only project facts, and a scanner must not see a secret flow into it).
   */
  readonly oauthGrants?: () => SbxOauthGrants | undefined;
  readonly temp?: TempDirs;
  readonly platform?: NodeJS.Platform;
  /** The bridge dir as the host sees it: sbx hands the host's bundle to the sandbox through its `xfer/` (F8). */
  readonly evidenceDirOf?: (ticketId: number) => string | undefined;
  /** Every sync verdict: is the sandbox's refusal a host rewrite the commits can be carried over? (drives the dashboard action) */
  readonly onRewritten?: (ticketId: number, rewritten: boolean) => void;
  /** The base branch of a recorded merge conflict on this ticket, or null: while one is open every refresh ships `origin/<base>` in the bundle. */
  readonly conflictBaseRef?: (ticketId: number) => string | null;
  /**
   * The ticket's recorded placement: it picks the runner of every host step
   * (`@arch:AC-32`, `@arch:AC-43`). Null = none recorded, so the core decides.
   */
  readonly placementOf: (ticketId: number) => TicketPlacement | null;
  /** What `sshRunnerFor` needs for an `ssh` placement; absent = that placement refuses (D826). */
  readonly sshRunner?: SshRunnerDeps;
  /**
   * The ticket's (cloned) host worktree; `undefined` = no record. The ssh runner maps its gate cwd
   * from it, and the orphan cleanup's remote step uses it.
   */
  readonly worktreeOf?: (ticketId: number) => string | undefined;
  /**
   * The runner a launch resolved: it wins over the placement. A first launch records its
   * placement only after the launch sync, so the sync must not pick a runner from the core.
   */
  readonly launchRunner?: SessionRunner;
}

/**
 * The runner of a host step: the launch runner, else the recorded placement (`ssh` → `sshRunnerFor`,
 * which refuses with a reason and never returns undefined), else the core's sandbox kind: sbx
 * (claude, codex) or docker (opencode, opencode2). The core decides only for a NULL or non-ssh placement.
 */
export function sandboxRunnerFor(deps: SandboxSyncDeps, core: string | null, ticketId: number): SessionRunner | undefined {
  if (deps.launchRunner) return deps.launchRunner;
  const placement = deps.placementOf(ticketId);
  if (placement?.backend === 'ssh') {
    return sshRunnerFor(deps.sshRunner, placement, { ticketId, projectRoot: deps.projectRoot, hostWorktreePath: deps.worktreeOf?.(ticketId) });
  }
  if (isSbxCore(core)) {
    const name = sbxName({ projectRoot: deps.projectRoot, ticketId, core });
    const evidenceDir = deps.evidenceDirOf?.(ticketId);
    const memory = deps.sbxMemory?.();
    // Read lazily: the grant value must never ride the object that names the sandbox.
    const grants = deps.oauthGrants?.();
    return createSbxSessionRunner({
      proc: deps.proc ?? NODE_SBX_PROCESS,
      core,
      name,
      // Stryker disable next-line ArrayDeclaration: equivalent, the runner only asks whether ITS name is in the set
      existing: [],
      cloneDir: sbxCloneDir(deps.projectRoot, name),
      ...(evidenceDir ? { evidenceDir } : {}),
      ...(memory ? { memory } : {}),
      ...(grants ? { oauth: { grants } } : {}),
    });
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
    await deps.notify.error(`The sandbox of ${target.ticketLabel} did not sync. The ticket has no worktree branch.`);
    return false;
  }
  const runner = sandboxRunnerFor(deps, target.core, target.ticketId);
  if (!runner?.sync) {
    await deps.notify.error(`${target.ticketLabel} has no sandbox (core ${target.core ?? 'unknown'}).`);
    return false;
  }
  const probe = await probeOf(runner);
  if (probe.state !== 'present') {
    await deps.notify.error(probe.state === 'unknown' ? `The sandbox of ${target.ticketLabel} did not sync: ${unknownReason(runner, probe)}` : `${target.ticketLabel} has no sandbox to sync.`);
    return false;
  }
  const result = await runner.sync({ hostWorktreePath: target.worktree.path, branch: target.worktree.branch });
  if (!result.ok) {
    const rewritten = /not a fast-forward/i.test(result.reason) && (await isRewritten(deps, { path: target.worktree.path, branch: target.worktree.branch, ticketId: target.ticketId }));
    deps.onRewritten?.(target.ticketId, rewritten);
    await deps.notify.error(`The sandbox of ${target.ticketLabel} did not sync: ${result.reason}${rewritten ? ' The host branch was rewritten. Use "Carry sandbox commits onto host branch" on the dashboard.' : ''}`);
    return false;
  }
  deps.onRewritten?.(target.ticketId, false);
  await recordSyncedHead(deps, target);
  // An open conflict: the agent merges the clone's `refs/karst/base/<base>`, so the manual Sync also ships the fresh base in.
  const opts = baseOpts(deps, target.ticketId);
  if (opts.baseRef && runner.refresh) {
    try {
      const refreshed = await runner.refresh({ hostWorktreePath: target.worktree.path, branch: target.worktree.branch }, opts);
      if (!refreshed.ok) {
        await deps.notify.error(`The sandbox of ${target.ticketLabel} did not sync: ${refreshed.reason}`);
        return false;
      }
    } catch (err) {
      await deps.notify.error(`The sandbox of ${target.ticketLabel} did not sync: the sandbox refresh failed (${reasonText(err)}).`);
      return false;
    }
  }
  deps.notify.info(`${target.ticketLabel}: ${result.summary}.`);
  return true;
}

export type EnsureSyncResult =
  | { readonly ok: true }
  /** `rewritten`: the divergence is a host rebase/amend the sandbox's commits can be carried over (arch:AC-51). */
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
      if (!refreshed.ok && opts.allowDirtyClone && isDirtyNotBehind(refreshed.reason)) return { ok: true };
      return refreshed.ok ? { ok: true } : { ok: false, reason: refreshed.reason, diverged: /diverged/i.test(refreshed.reason) };
    } catch (err) {
      return { ok: false, reason: `sandbox refresh failed: ${reasonText(err)}`, diverged: false };
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
      return { ok: false, reason: `sandbox refresh failed: ${reasonText(err)}` };
    }
    deps.notify.info(`Updated the sandbox of ${target.ticketLabel} from the host. Uncommitted sandbox work is in the stash "${stash}" (run git stash list inside the sandbox).`);
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
    // The failed sync left the clone's branch in the private sandbox ref, which the classifier reads.
    const rewritten = diverged && (await isRewritten(deps, { path: target.worktree.path, branch: target.worktree.branch, ticketId: target.ticketId }));
    if (diverged) deps.onRewritten?.(target.ticketId, rewritten);
    return { ok: false, reason: result.reason, diverged, ...(rewritten ? { rewritten } : {}) };
  } catch (err) {
    return { ok: false, reason: `sandbox sync failed: ${reasonText(err)}`, diverged: false };
  }
}

/** The runner's tri-state probe; a runner without one falls back to `hasSandbox`, a throw is `unknown`. */
export async function probeOf(runner: SessionRunner): Promise<SandboxProbe> {
  try {
    if (runner.probeSandbox) return await runner.probeSandbox();
    return (await runner.hasSandbox?.()) ? { state: 'present' } : { state: 'absent' };
  } catch (err) {
    return { state: 'unknown', reason: reasonText(err) };
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

/** Is the refused sync a host rewrite? Needs the clone's branch in the private sandbox ref of the host worktree. */
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
    await deps.notify.error(`The sandbox of ${target.ticketLabel} was not removed. The hook endpoint is still starting. Try again.`);
    return false;
  }
  if (!target.worktree?.branch) {
    await deps.notify.error(`${target.ticketLabel} has no worktree branch.`);
    return false;
  }
  const runner = sandboxRunnerFor(deps, target.core, target.ticketId);
  if (!runner?.dispose) {
    await deps.notify.error(`${target.ticketLabel} has no sandbox (core ${target.core ?? 'unknown'}).`);
    return false;
  }
  try {
    const removal = await runner.dispose({ hostWorktreePath: target.worktree.path, branch: target.worktree.branch });
    if (!removal.ok) {
      await deps.notify.error(`The sandbox of ${target.ticketLabel} was not removed (${disposeFailures(removal)}). Its evidence folder stays.`);
      return false;
    }
  } catch (err) {
    await deps.notify.error(`The sandbox of ${target.ticketLabel} was not removed: ${reasonText(err)}`);
    return false;
  }
  try {
    await bridges.dispose(target.ticketId);
  } catch (err) {
    await deps.notify.error(`Removed the sandbox of ${target.ticketLabel}. The evidence folder stays: ${reasonText(err)}`);
    return false;
  }
  deps.notify.info(`Removed the sandbox of ${target.ticketLabel}.`);
  return true;
}

/**
 * `karst.sandbox.rebuild`: remove a sandbox whose clone is empty so the next Open AI Session recreates it from
 * the host branch. The runner refuses unless the host branch and the sync ref hold all of the sandbox's commits.
 */
export async function rebuildSandboxOp(deps: SandboxSyncDeps, target: SandboxSyncTarget): Promise<boolean> {
  if (!target.worktree?.branch) {
    await deps.notify.error(`${target.ticketLabel} has no worktree branch.`);
    return false;
  }
  const runner = sandboxRunnerFor(deps, target.core, target.ticketId);
  if (!runner?.rebuild) {
    await deps.notify.error(`${target.ticketLabel} has no sandbox that Karst can rebuild (core ${target.core ?? 'unknown'}).`);
    return false;
  }
  try {
    const removal = await runner.rebuild({ hostWorktreePath: target.worktree.path, branch: target.worktree.branch });
    if (!removal.ok) {
      await deps.notify.error(`The sandbox of ${target.ticketLabel} was not rebuilt (${disposeFailures(removal)}).`);
      return false;
    }
  } catch (err) {
    await deps.notify.error(`The sandbox of ${target.ticketLabel} was not rebuilt: ${reasonText(err)}`);
    return false;
  }
  deps.notify.info(`Removed the sandbox of ${target.ticketLabel}. Open an AI session to recreate it from the host branch.`);
  return true;
}


function isSbxCore(core: string | null): core is SbxCore {
  return core !== null && (SBX_CORES as readonly string[]).includes(core);
}
