import { join } from 'node:path';
import type { Manifest } from '../../manifest/types.js';
import { backendForCore, selectedSandboxBackends, type AgentBackends } from '../../agent/backendChoices.js';
import type { Store } from '../../store/db.js';
import { bridgePaths, type BridgePaths } from '../../agent/bridge/bridgeDir.js';
import { isDockerCore } from '../../agent/docker/dockerImage.js';
import { dockerNames } from '../../agent/docker/dockerNames.js';
import { NODE_DOCKER_PROCESS, type DockerProcess } from '../../agent/docker/dockerProcess.js';
import { createDockerSessionRunner } from '../../agent/docker/dockerRunner.js';
import { resolveDockerMemoryLimits, queryDockerMemTotal, type SandboxMemoryConfig } from '../../agent/docker/dockerMemory.js';
import { DOCKER_ASSETS_DIR, linuxUser } from '../../agent/docker/resolveDocker.js';
import { sbxName } from '../../agent/sbx/sbxName.js';
import { NODE_SBX_PROCESS, type SbxProcess } from '../../agent/sbx/sbxProcess.js';
import { sbxCloneDir } from '../../agent/sbx/sbxClone.js';
import { createSbxSessionRunner, SBX_CORES } from '../../agent/sbx/sbxRunner.js';
import { resolveGateSlots, resolveSbxLimits, type SandboxLimitsConfig } from '../../agent/sbx/sbxLimits.js';
import { resolveSbxMemory } from '../../agent/sbx/sbxMemory.js';
import { availableParallelism, totalmem } from 'node:os';
import { withGateSlot, type GateSlotDeps } from './gateSlotOps.js';
import { dockerKillContext } from '../../agent/backendProbe.js';
import { listProjectSandboxes, type ProjectSandbox } from '../../agent/sandboxInventory.js';
import type { SandboxChannel } from '../../workflow/messageDelivery.js';
import { assertNoSandboxResumeOnHost } from '../../agent/sandboxResumeGuard.js';
import { pickTicketSandbox } from '../../agent/sandboxLookup.js';
import { allowBaselineHostPorts, baselineHostPorts, ticketBaselineKeys } from '../../agent/sandboxHostAllow.js';
import { resetSandboxServices, reverifySandboxServices, stopAllTicketServers, type ReverifyResult } from '../../agent/sandboxServices.js';
import { createUserUatGate } from '../../agent/userUatGate.js';
import { unitByKey } from '../../manifest/runnable.js';
import type { SandboxProbe, SessionRunner } from '../../agent/sessionRunner.js';
import type { SandboxServiceContext } from '../../runtime/startService.js';
import { runProcess, type GateProcessRunner } from '../../workflow/gates/run.js';
import { isServing } from '../../runtime/health.js';
import { listWorktreesByTicket } from '../../store/dashboard.js';
import { readClonedWorktree } from '../../agent/clonedWorktree.js';
import { getTicket } from '../../store/tickets.js';
import { getPlacement, type TicketPlacement } from '../../store/placement.js';
import { clearSetupState, DOCKER_MEMORY_HELP_TEXT, onceByMessage, provisionTicketSandbox, ticketCloneReady, warnMissingSetup } from './sandboxSetupOp.js';
import type { Notify } from './notify.js';
import { ticketToastLabel } from '../ticketToastLabel.js';
import type { EnsureSyncResult } from './sandboxSyncOps.js';
import { ticketHostGate } from './sandboxHostGate.js';
import { hasRunningHostPlacedServices, hasRunningHostServices, resetHostServices } from './hostUserUat.js';
import { blockedSshRunner } from './sshPlacementOps.js';
import { sshDockerKillContextFor, sshRunnerFor, type SshRunnerDeps } from './sshRunnerFor.js';

/**
 * Per-ticket sandbox lookups for services and gates (arch:AC-32). A ticket is
 * sandboxed only when the manifest's `agentBackends` entry for its session core
 * (sbx: claude/codex, docker: opencode/opencode2) AND its sandbox exists — a
 * session that failed closed to the host has none, so it keeps today's host
 * services and gates. No `vscode` import (ops ratchet).
 */
export interface TicketSandboxDeps {
  readonly backends: () => AgentBackends | undefined;
  /** The sandbox name hash input launch used: the manifest file, else the ticket worktree path (N10). */
  readonly projectRoot: (ticketId: number) => string;
  /** The ticket's session core (`tickets.session_provider`), or null. */
  readonly coreOf: (ticketId: number) => string | null;
  /**
   * The ticket's recorded placement (null = never recorded: legacy, derived from the core as before).
   * Recorded host = nothing is spawned; a recorded sandbox names the backend and core directly (arch:AC-32).
   */
  readonly placementOf?: (ticketId: number) => TicketPlacement | null;
  /** What `sshRunnerFor` needs for an `ssh` placement; absent = that placement refuses (D826). */
  readonly sshRunner?: SshRunnerDeps;
  /** The ticket's (cloned) host worktree: the ssh runner maps its gate cwd from it. */
  readonly worktreeOf?: (ticketId: number) => string | undefined;
  /** The ticket's evidence bridge paths, when the hook endpoint is up. */
  readonly bridgeOf?: (ticketId: number) => BridgePaths | undefined;
  /**
   * This project's sandboxes from the runners' own listing (F4). Absent = the
   * session provider alone decides (legacy / tests). It is the source of truth
   * once present: `coreOf` is only a hint for ties.
   */
  readonly inventory?: (ticketId: number) => Promise<readonly ProjectSandbox[]>;
  /** Last core the listing resolved for a ticket (sync callers read it back via `coreOf`). */
  readonly remember?: (ticketId: number, core: string | null) => void;
  /** Baseline host ports the docker proxy keeps allowing while a setup window recreates it. */
  readonly hostPortsOf?: (ticketId: number) => readonly number[];
  readonly proxyScript?: string;
  /** The manifest's `sandboxMemory` overrides and the Docker VM size (bytes, once known) behind a gate container's limits. */
  readonly sandboxMemory?: () => SandboxMemoryConfig | undefined;
  readonly memTotalBytes?: () => number | undefined;
  /** The manifest's `sandboxLimits`: cpus and the worker opt-out for the sbx gate runner, gate slots for every sandbox gate. */
  readonly sandboxLimits?: () => SandboxLimitsConfig | undefined;
  /** Project-wide gate slots (absent = no slots, e.g. tests). */
  readonly gateSlots?: Omit<GateSlotDeps, 'limit'>;
  readonly proc?: SbxProcess;
  readonly dockerProc?: DockerProcess;
  readonly platform?: NodeJS.Platform;
  readonly debug?: (message: string) => void;
  /** Non-blocking user warning (bound from `notify.warn`, deduped): a lockfile repo with no `sandbox.setup` (arch:AC-40). */
  readonly warn?: (message: string) => void;
}

export interface TicketSandbox {
  readonly runner: SessionRunner;
  readonly sandboxName: string;
}

/** The runner the backend would use for this ticket's core, or undefined (host). Sync: no probe. */
export function ticketSandboxRunner(deps: TicketSandboxDeps, ticketId: number, coreOverride?: string | null): TicketSandbox | undefined {
  const placement = deps.placementOf?.(ticketId) ?? null;
  if (placement?.backend === 'host') return undefined;
  // The recorded placement picks the runner (D826): an ssh ticket gets the ssh runner, or one that
  // refuses with the reason (never `undefined`, so no gate runs on the host clone).
  // Only a recorded placement is `ssh` (the configured value is `ssh:<remote>`).
  if (placement?.backend === 'ssh') return sshTicketSandbox(deps, ticketId, placement);
  const core = coreOverride === undefined ? (placement?.core ?? deps.coreOf(ticketId)) : coreOverride;
  if (core === null) return undefined;
  const backend = placement ? placement.backend : backendForCore(deps.backends(), core);
  const bridge = deps.bridgeOf?.(ticketId);
  const projectRoot = deps.projectRoot(ticketId);
  if (backend === 'sbx' && (SBX_CORES as readonly string[]).includes(core)) {
    const name = sbxName({ projectRoot, ticketId, core });
    const runner = createSbxSessionRunner({
      proc: deps.proc ?? NODE_SBX_PROCESS, core: core as 'claude' | 'codex', name, existing: [], cloneDir: sbxCloneDir(projectRoot, name),
      memory: resolveSbxMemory(totalmem(), deps.sandboxMemory?.()?.sbxMemory),
      ...resolveSbxLimits(availableParallelism(), deps.sandboxLimits?.()),
      ...(bridge ? { evidenceDir: bridge.dir } : {}),
    });
    return { runner, sandboxName: name };
  }
  if (backend === 'docker' && isDockerCore(core)) {
    const names = dockerNames({ projectRoot, ticketId, core });
    const runner = createDockerSessionRunner({
      proc: deps.dockerProc ?? NODE_DOCKER_PROCESS, core, names,
      user: linuxUser(deps.platform ?? process.platform, process.getuid?.(), process.getgid?.()),
      memory: resolveDockerMemoryLimits(deps.memTotalBytes?.(), deps.sandboxMemory?.()),
      ...(bridge ? { evidenceDir: bridge.runDir } : {}),
      ...(deps.proxyScript ? { proxy: { script: deps.proxyScript, hostPorts: deps.hostPortsOf?.(ticketId) ?? [] } } : {}),
    });
    return { runner, sandboxName: names.container };
  }
  return undefined;
}

export interface ResolvedTicketSandbox {
  /** The runner for the resolved core, when the backend config can host it. */
  readonly found: TicketSandbox | undefined;
  /** The listed sandbox that proves this ticket HAS one (absent when only the hint matched). */
  readonly listed: ProjectSandbox | undefined;
  /** Why the listing could not answer (CLI missing, daemon down); set means an unlisted ticket is NOT proven sandbox-free. */
  readonly listingError?: string;
}

/** The ticket's sandbox from the listing first, `sessionProvider` as the hint (F4). Never throws. */
export async function resolveTicketSandbox(deps: TicketSandboxDeps, ticketId: number): Promise<ResolvedTicketSandbox> {
  const placement = deps.placementOf?.(ticketId) ?? null;
  // Recorded host: nothing to find, and never spawn a runner CLI for it.
  if (placement?.backend === 'host') return { found: undefined, listed: undefined };
  const hint = placement?.core ?? deps.coreOf(ticketId);
  let listed: ProjectSandbox | undefined;
  let listingError: string | undefined;
  if (deps.inventory) {
    const all = await deps.inventory(ticketId).catch((err: unknown) => {
      listingError = err instanceof Error ? err.message : String(err);
      deps.debug?.(`[sandbox] ticket ${ticketId}: listing failed (${listingError}); using the session provider`);
      return [] as readonly ProjectSandbox[];
    });
    listed = pickTicketSandbox(all, ticketId, hint, (m) => deps.debug?.(`[sandbox] ${m}`));
    deps.remember?.(ticketId, listed?.core ?? null);
  }
  const core = listed?.core ?? hint;
  let found: TicketSandbox | undefined;
  try {
    found = ticketSandboxRunner(deps, ticketId, core);
  } catch (err) {
    deps.debug?.(`[sandbox] ticket ${ticketId}: no runner for core ${String(core)} (${err instanceof Error ? err.message : String(err)})`);
  }
  return { found, listed, ...(listingError !== undefined ? { listingError } : {}) };
}

/** The runner of a recorded ssh placement: the ssh runner, or one that refuses with the reason. Its core does not matter. */
function sshTicketSandbox(deps: TicketSandboxDeps, ticketId: number, placement: TicketPlacement): TicketSandbox {
  const runner = sshRunnerFor(deps.sshRunner, placement, {
    ticketId,
    projectRoot: deps.projectRoot(ticketId),
    hostWorktreePath: deps.worktreeOf?.(ticketId),
    // A one-shot gate container on a remote docker daemon gets the same memory limits as a local one.
    ...(deps.sandboxMemory ? { sandboxMemory: deps.sandboxMemory() } : {}),
    ...(deps.memTotalBytes ? { memTotalBytes: deps.memTotalBytes() } : {}),
  });
  return { runner, sandboxName: placement.sandboxName ?? '' };
}

/** The runner of a recorded ssh placement and its probe; undefined for every other placement. The listing has no ssh entries. */
export async function sshTicketProbe(deps: TicketSandboxDeps, ticketId: number): Promise<{ readonly found: TicketSandbox; readonly probe: SandboxProbe } | undefined> {
  const placement = deps.placementOf?.(ticketId);
  if (placement?.backend !== 'ssh') return undefined;
  const found = sshTicketSandbox(deps, ticketId, placement);
  // `sshRunnerFor` gives the ssh runner or `blockedSshRunner`; both implement the probe.
  const probe = await found.runner.probeSandbox!()
    .catch((err: unknown): SandboxProbe => ({ state: 'unknown', reason: err instanceof Error ? err.message : String(err) }));
  return { found, probe };
}

/** An ssh ticket's sandbox counts as there unless a reachable, trusted remote says `absent` (`@arch:AC-39`): never a silent host run. */
async function sshHasSandbox(deps: TicketSandboxDeps, ticketId: number): Promise<boolean | undefined> {
  const ssh = await sshTicketProbe(deps, ticketId);
  return ssh === undefined ? undefined : ssh.probe.state !== 'absent';
}

/** Why an ssh ticket's step is refused: its probe is not `present`. */
function sshRefusal(ticketId: number, probe: SandboxProbe): string {
  return probe.state === 'unknown'
    ? `ticket ${ticketId} runs on ssh and its remote cannot be used: ${probe.reason}; nothing runs on the host for it`
    : `ticket ${ticketId} runs on ssh and its remote clone is gone; nothing runs on the host for it`;
}

/**
 * The kill-context reader of a ticket's sandbox setup: what explains a killed
 * (137) setup. An ssh placement reads its REMOTE daemon (D822, through the same
 * trust check as every host step); every other placement keeps the local docker
 * one, and a non-docker ticket has none.
 */
export function ticketKillContextOf(deps: TicketSandboxDeps, ticketId: number): (() => Promise<string | undefined>) | undefined {
  const placement = deps.placementOf?.(ticketId);
  if (placement?.backend === 'ssh') return sshDockerKillContextFor(deps.sshRunner, placement);
  // Stryker disable next-line StringLiteral: equivalent, `backendForCore` only needs a core NAME and '' selects the host
  return (placement?.backend ?? backendForCore(deps.backends(), deps.coreOf(ticketId) ?? '')) === 'docker' ? () => dockerKillContext(deps.dockerProc) : undefined;
}

/**
 * The services context, only when the sandbox exists. An ssh ticket always gets one
 * (D826): `undefined` would start its services on the host, so a remote that cannot
 * be used gives a context whose runner refuses with the reason.
 */
export async function ticketSandboxContext(deps: TicketSandboxDeps, ticketId: number): Promise<SandboxServiceContext | undefined> {
  const ssh = await sshTicketProbe(deps, ticketId);
  if (ssh !== undefined) {
    if (ssh.probe.state === 'present') return { runner: ssh.found.runner, sandboxName: ssh.found.sandboxName };
    return { runner: blockedSshRunner(sshRefusal(ticketId, ssh.probe)), sandboxName: ssh.found.sandboxName };
  }
  const { found, listed } = await resolveTicketSandbox(deps, ticketId);
  if (!found || !(listed || (await found.runner.hasSandbox?.()))) return undefined;
  return { runner: found.runner, sandboxName: found.sandboxName };
}

/**
 * The ticket's gate boundary: inside its sandbox when it exists, else the host
 * `runProcess`. Only `slotted` callers (real gates) take a project-wide slot; setup and clone checks do not. A ticket that HAS a sandbox never runs a gate on the host: with
 * no runner able to exec there, the gate is refused (`spawnFailed`, no verdict;
 * arch:AC-31/AC-32). Undefined when no sandbox backend is configured and the
 * session provider names no sandboxed core, so host tickets stay byte-identical.
 */
export function ticketGateProcess(deps: TicketSandboxDeps, ticketId: number, opts: { readonly slotted?: boolean } = {}): GateProcessRunner | undefined {
  if (deps.placementOf?.(ticketId)?.backend === 'host') return undefined;
  const legacy = ticketSandboxRunner(deps, ticketId);
  const listing = deps.inventory !== undefined && selectedSandboxBackends(deps.backends()).length > 0;
  if (!listing && !legacy?.runner.runGate) return undefined;
  const slot = (gate: GateProcessRunner): GateProcessRunner =>
    opts.slotted && deps.gateSlots ? withGateSlot({ ...deps.gateSlots, limit: () => resolveGateSlots(deps.sandboxLimits?.()) }, ticketId, gate) : gate;
  return async (command, args, cwd, options) => {
    // An ssh ticket's gate runs on its remote or is refused (D826): never `runProcess` on the host.
    const ssh = await sshTicketProbe(deps, ticketId);
    if (ssh !== undefined) {
      if (ssh.probe.state !== 'present') {
        const reason = `gate refused: ${sshRefusal(ticketId, ssh.probe)}`;
        deps.debug?.(`[gate] ${reason}`);
        return { kind: 'spawnFailed', message: reason, output: reason };
      }
      deps.debug?.(`[gate] ticket ${ticketId}: ${command} runs in ssh (${ssh.found.sandboxName})`);
      // The ssh runner and `blockedSshRunner` both implement the gate.
      return slot(ssh.found.runner.runGate!)(command, args, cwd, options);
    }
    const { found, listed } = await resolveTicketSandbox(deps, ticketId);
    const sandboxGate = found?.runner.runGate;
    if (listed && !sandboxGate) {
      const reason = `gate refused: ticket ${ticketId} has a sandbox (${listed.name}) but no runner can execute gates there; gates never run on the host for a sandboxed ticket`;
      deps.debug?.(`[gate] ${reason}`);
      return { kind: 'spawnFailed', message: reason, output: reason };
    }
    const inside = sandboxGate !== undefined && (listed !== undefined || (await found!.runner.hasSandbox?.()) === true);
    deps.debug?.(`[gate] ticket ${ticketId}: ${command} runs ${inside ? `in ${found!.runner.kind} (${found!.sandboxName})` : 'on the host (no sandbox)'}`);
    if (!inside) return runProcess(command, args, cwd, options);
    // A sandbox gate takes a project-wide slot (agents do not): gates of different tickets cannot all build at once.
    return slot(sandboxGate!)(command, args, cwd, options);
  };
}

/**
 * On (re)attach: let the sandbox reach its baseline ports (sbx rule; docker's
 * proxy got them at prepare), then re-verify every recorded service mapping.
 * Null when the ticket has no sandbox or the sandbox cannot answer yet.
 */
export async function reattachTicketSandbox(
  deps: TicketSandboxDeps,
  store: Store,
  manifest: Manifest,
  ticketId: number,
  isHealthy: (row: { repo: string; port: number }) => Promise<boolean>,
): Promise<ReverifyResult | null> {
  const ctx = await ticketSandboxContext(deps, ticketId);
  if (!ctx) return null;
  const allow = await allowBaselineHostPorts(ctx.runner, baselineHostPorts(manifest, ticketBaselineKeys(store, ticketId)));
  if (!allow.ok) {
    deps.debug?.(`[runtime] ticket ${ticketId}: baseline allow failed: ${allow.reason}`);
    deps.warn?.(`The sandbox of ${ticketToastLabel(store, ticketId)} cannot reach its baseline services on the host: ${allow.reason}`);
  }
  const runGate = ctx.runner.runGate;
  await warnMissingSetup(deps, { manifest: () => manifest, worktrees: (id) => listWorktreesByTicket(store, id), gateProcess: () => runGate }, ticketId);
  const result = await reverifySandboxServices(store, ticketId, ctx.runner, isHealthy);
  if (result) {
    deps.debug?.(`[runtime] ticket ${ticketId}: sandbox re-verify republished [${result.republished.join(', ')}], dropped [${result.dropped.join(', ')}]`);
  }
  return result;
}

/** How long after a launch the sandbox is given to come up before its mappings are re-verified. */
export const SANDBOX_REATTACH_DELAY_MS = 15_000;

/**
 * Decision 6: after a (re)attach, re-verify the ticket's recorded sandbox
 * mappings once the sandbox had time to come up. Async, best-effort; a host
 * backend schedules nothing.
 */
export function scheduleSandboxReattach(
  deps: TicketSandboxDeps | undefined,
  store: Store,
  manifest: Manifest | undefined,
  ticketId: number,
  isHealthy: (row: { repo: string; port: number }) => Promise<boolean>,
  onError: (err: unknown) => void,
  delayMs = SANDBOX_REATTACH_DELAY_MS,
): boolean {
  if (!deps || !manifest || selectedSandboxBackends(manifest.agentBackends).length === 0) return false;
  setTimeout(() => {
    reattachTicketSandbox(deps, store, manifest, ticketId, isHealthy).catch(onError);
  }, delayMs).unref?.();
  return true;
}

/** Wraps a spin so a sandboxed ticket's hot services start inside its sandbox. */
export function withSandboxSpin<S, M, O extends object, R>(
  deps: () => TicketSandboxDeps | undefined,
  spin: (store: S, manifest: M, ticketId: number, hot: string[], opts?: O & { sandbox?: SandboxServiceContext }) => Promise<R>,
  beforeSpin?: (ticketId: number) => Promise<void>,
): (store: S, manifest: M, ticketId: number, hot: string[], opts?: O) => Promise<R> {
  return async (store, manifest, ticketId, hot, opts) => {
    await beforeSpin?.(ticketId);
    const d = deps();
    const sandbox = d ? await ticketSandboxContext(d, ticketId) : undefined;
    return spin(store, manifest, ticketId, hot, { ...(opts ?? ({} as O)), ...(sandbox ? { sandbox } : {}) });
  };
}

export interface TicketSandboxBindingsInput extends Omit<TicketSandboxDeps, 'bridgeOf'> {
  /** The bridge registry's root once the hook endpoint is bound. */
  readonly bridgeRoot: () => string | undefined;
  readonly store: Store;
  readonly manifest: () => Manifest | undefined;
  readonly onError: (err: unknown) => void;
  readonly notify?: Notify;
  /** Re-run setup's tail: clear the sandbox-setup block and re-drive the stage. */
  readonly redriveAfterSetup?: (ticketId: number) => void;
  readonly openFile?: (path: string) => void;
  /** The two-way sync before a `sandbox: host` gate (`ensureInSync`); lazy because the sync wiring is built after these bindings. */
  readonly ensureInSync?: (ticketId: number) => Promise<EnsureSyncResult>;
  /** The host itself stopped this ticket's sandbox after an accepted marker (arch:AC-37): host gates still run. */
  readonly hostEnded?: (ticketId: number) => boolean;
}

/** Everything extension.ts binds for sandboxed tickets (arch:AC-32), so the host file stays bindings-only. */
export function createTicketSandboxBindings(input: TicketSandboxBindingsInput) {
  const cores = new Map<number, string>();
  let memTotal: number | undefined;
  let memProbe: Promise<void> | undefined;
  const deps: TicketSandboxDeps = {
    ...input,
    ...(input.notify ? { warn: onceByMessage((m) => input.notify!.warn(m)) } : {}),
    // The listing's answer wins over the (possibly null) session provider for every sync reader too.
    coreOf: (ticketId) => cores.get(ticketId) ?? input.coreOf(ticketId),
    placementOf: input.placementOf ?? ((ticketId) => getPlacement(input.store, ticketId)),
    inventory: input.inventory ?? (async (ticketId) => {
      const inv = await listProjectSandboxes({
        projectRoot: input.projectRoot(ticketId), sbx: input.proc ?? NODE_SBX_PROCESS, docker: input.dockerProc ?? NODE_DOCKER_PROCESS,
      });
      // A configured runner that could not list may be the one holding this ticket's sandbox: not "none" (arch:AC-39).
      const wanted = selectedSandboxBackends(input.backends());
      const failed = inv.errors.filter((e) => wanted.some((kind) => e.startsWith(`${kind} `)));
      if (failed.length > 0 && !inv.sandboxes.some((b) => b.ticketId === ticketId)) throw new Error(failed.join('; '));
      return inv.sandboxes;
    }),
    sandboxMemory: () => input.manifest()?.sandboxMemory,
    sandboxLimits: () => input.manifest()?.sandboxLimits,
    gateSlots: input.gateSlots ?? { store: input.store, projectIdOf: (id) => getTicket(input.store, id).projectId, owner: String(process.pid), ...(input.debug ? { debug: input.debug } : {}) },
    memTotalBytes: () => {
      memProbe ??= queryDockerMemTotal(input.dockerProc ?? NODE_DOCKER_PROCESS).then((v) => { memTotal = v; });
      return memTotal;
    },
    proxyScript: input.proxyScript ?? join(DOCKER_ASSETS_DIR, 'allowlist-proxy.mjs'),
    hostPortsOf: (ticketId) => { const m = input.manifest(); return m ? baselineHostPorts(m, ticketBaselineKeys(input.store, ticketId)) : []; },
    remember: (ticketId, core) => { if (core === null) cores.delete(ticketId); else cores.set(ticketId, core); },
    bridgeOf: (ticketId) => {
      const root = input.bridgeRoot();
      return root === undefined ? undefined : bridgePaths(root, ticketId);
    },
    // The cloned worktree, like the sync wiring's target (the ssh runner maps its gate cwd from it, D826).
    worktreeOf: input.worktreeOf ?? ((ticketId) => {
      const root = input.bridgeRoot();
      const worktrees = listWorktreesByTicket(input.store, ticketId);
      return (readClonedWorktree(root === undefined ? undefined : bridgePaths(root, ticketId).dir, worktrees) ?? worktrees[0])?.path;
    }),
  };
  const uatGate = createUserUatGate();
  const bindings = {
    deps,
    /** The headless-run guard (`instrumentedAdapter.guardResume`): a host run never resumes a sandbox session id (AC-33). */
    guardResume: async (opts: { readonly resume?: string; readonly tracking?: { readonly ticketId?: number | null } }): Promise<void> => {
      const ticketId = opts.tracking?.ticketId;
      if (opts.resume === undefined || ticketId === undefined || ticketId === null) return;
      assertNoSandboxResumeOnHost({ ticketId, resume: opts.resume, runner: 'host', hasSandbox: await bindings.hasSandbox(ticketId) });
    },
    /**
     * Does the runners' listing show a sandbox for this ticket? (false when it cannot tell: no backend, listing failed)
     * An ssh placement reads its remote instead (D826): only `absent` on a reachable, trusted remote is false.
     */
    hasSandbox: async (ticketId: number): Promise<boolean> =>
      (await sshHasSandbox(deps, ticketId)) ?? (await resolveTicketSandbox(deps, ticketId)).listed !== undefined,
    /** The tri-state behind it: a listing that failed (no CLI, daemon down) and found no sandbox is `unknown`, never `absent` (arch:AC-39). */
    probeSandbox: async (ticketId: number): Promise<SandboxProbe> => {
      const ssh = await sshTicketProbe(deps, ticketId);
      if (ssh !== undefined) return ssh.probe;
      const { listed, listingError } = await resolveTicketSandbox(deps, ticketId);
      if (listed) return { state: 'present' };
      return listingError !== undefined ? { state: 'unknown', reason: listingError } : { state: 'absent' };
    },
    /** Record (or clear, `null`) the core whose sandbox serves a ticket: set at launch, read back by the sync callers. */
    remember: (ticketId: number, core: string | null) => deps.remember?.(ticketId, core),
    /**
     * How a sandboxed session reaches karst for pointer text (arch:AC-34): the bridge dir as the agent
     * sees it plus its script dir. Undefined for a host session (no sandbox remembered for the ticket).
     */
    sandboxChannel: (ticketId: number): SandboxChannel | undefined => {
      const placement = deps.placementOf?.(ticketId) ?? null;
      if (placement?.backend === 'host') return undefined;
      const core = placement?.core ?? cores.get(ticketId);
      const bridge = deps.bridgeOf?.(ticketId);
      if (core === undefined || !bridge) return undefined;
      const runDir = ticketSandboxRunner(deps, ticketId, core)?.runner.bridgeRunDir?.(bridge);
      return runDir === undefined ? undefined : { kind: 'sandbox', runDir, core };
    },
    /** Decision 7: open/copy of a ticket's service link is withheld during agent UAT. */
    userUatWithheld: (ticketId: number) => uatGate.isWithheld(ticketId),
    /** Decisions 7-8 for the UAT stage: keep a sandboxed stack, reset it, gate the link. */
    userUat: {
      // Sandboxed: a stack with a row in the sandbox or a running `sandbox: host` service (arch:AC-36).
      // Host: only when the manifest opts in (`uat.keepStackForUser`) and a host service is running.
      keepStackForUserUat: (ticketId: number) => {
        const manifest = input.manifest();
        const isHostPlaced = (key: string): boolean => (manifest ? unitByKey(manifest, key)?.def.sandbox === 'host' : false);
        const sandboxed = ticketSandboxRunner(deps, ticketId) !== undefined;
        return (
          (sandboxed &&
            (input.store.db.prepare("SELECT 1 FROM servers WHERE ticket_id = ? AND status = 'running' AND sandbox IS NOT NULL").get(ticketId) !== undefined ||
              hasRunningHostPlacedServices(input.store, ticketId, isHostPlaced))) ||
          (manifest?.uat?.keepStackForUser === true && hasRunningHostServices(input.store, ticketId))
        );
      },
      prepareUserUat: async (store: Store, ticketId: number): Promise<string[]> => {
        const manifest = input.manifest();
        if (!manifest) return [];
        const defOf = (key: string) => unitByKey(manifest, key)?.def;
        const found = ticketSandboxRunner(deps, ticketId);
        const sandboxWarnings = found ? await resetSandboxServices(store, ticketId, found.runner, defOf) : [];
        // A sandboxed ticket resets its `sandbox: host` services on the host; the opt-in resets every host service.
        const hostResetOf =
          manifest.uat?.keepStackForUser === true
            ? defOf
            : found
              ? (key: string) => (defOf(key)?.sandbox === 'host' ? defOf(key) : undefined)
              : undefined;
        const hostWarnings = hostResetOf ? await resetHostServices(store, ticketId, hostResetOf, runProcess) : [];
        return [...sandboxWarnings, ...hostWarnings];
      },
      agentUatPhase: (ticketId: number, phase: 'start' | 'end') => {
        if (phase === 'start') uatGate.withhold(ticketId);
        else uatGate.release(ticketId);
      },
    },
    gateProcessFor: (ticketId: number) => ticketGateProcess(deps, ticketId, { slotted: true }),
    /** arch:AC-36: run the repos' `sandbox.setup` inside the sandbox; refused = a reason, notified once. Host ticket / no notify seam = ok. */
    provision: async (ticketId: number, opts: { readonly signal?: AbortSignal; readonly background?: boolean } = {}) => {
      // `ticketGateProcess` falls back to the HOST runner without a sandbox: never run a setup there.
      const { notify } = input;
      if (!notify || !(await resolveTicketSandbox(deps, ticketId)).listed) return { ok: true as const };
      return provisionTicketSandbox({
        manifest: input.manifest, worktrees: (id) => listWorktreesByTicket(input.store, id), gateProcess: (id) => ticketGateProcess(deps, id),
        bridgeOf: (id) => deps.bridgeOf?.(id), ticketLabel: (id) => { try { return getTicket(input.store, id).key ?? String(id); } catch { return String(id); } },
        notify,
        actions: {
          rerun: async (id) => { await bindings.rerunSetup(id); input.redriveAfterSetup?.(id); },
          openLog: (path) => input.openFile?.(path),
          memoryHelp: () => notify.info(DOCKER_MEMORY_HELP_TEXT),
        },
        ...(input.debug ? { debug: input.debug } : {}),
        windowOf: (id) => ticketSandboxRunner(deps, id)?.runner,
        killContextOf: (id) => ticketKillContextOf(deps, id),
        turnActive: (id) => { try { return getTicket(input.store, id).agentState === 'running'; } catch { return false; } },
      }, ticketId, opts);
    },
    /** Is the ticket's clone checked out (HEAD resolves, tree non-empty)? Always true without a sandbox. */
    cloneReady: async (ticketId: number): Promise<boolean> => {
      if (!(await resolveTicketSandbox(deps, ticketId)).listed) return true;
      return ticketCloneReady({ manifest: input.manifest, worktrees: (id) => listWorktreesByTicket(input.store, id), gateProcess: (id) => ticketGateProcess(deps, id) }, ticketId);
    },
    /** `karst.sandbox.setup`: forget the recorded setup, then run it again now (an unchanged lockfile would otherwise skip it). */
    rerunSetup: async (ticketId: number): Promise<void> => {
      const bridge = deps.bridgeOf?.(ticketId);
      if (bridge) await clearSetupState(bridge);
      const r = await bindings.provision(ticketId);
      if (r.ok) void input.notify?.info(`The sandbox setup of ${ticketToastLabel(input.store, ticketId)} finished.`);
    },
    /**
     * Background start right after launch/reattach (arch:AC-36): never blocks the session. The sandbox may
     * still be coming up, so wait (bounded) for it to be listed before running the setup.
     */
    provisionInBackground: (ticketId: number, wait: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))): void => {
      void (async () => {
        for (let i = 0; i < 12; i += 1) {
          if ((await resolveTicketSandbox(deps, ticketId)).listed) break;
          await wait(5_000);
        }
        // The clone's checkout may lag the listing: wait (bounded) for it, else leave setup to the pre-gate run.
        let ready = false;
        for (let i = 0; i < 12 && !ready; i += 1) {
          ready = await bindings.cloneReady(ticketId);
          if (!ready) await wait(5_000);
        }
        if (!ready) return;
        await bindings.provision(ticketId, { background: true });
      })().catch(input.onError);
    },
    hostGateFor: (ticketId: number) => {
      // Only start and dirty-check probes use this runner; the gate itself runs on the host, so it takes no slot.
      const sandboxGate = ticketGateProcess(deps, ticketId);
      const sync = input.ensureInSync;
      return sandboxGate && sync ? ticketHostGate({ sandbox: deps, sync, ...(input.hostEnded ? { hostEnded: input.hostEnded } : {}) }, ticketId, sandboxGate) : undefined;
    },
    /** Stop-all: sandboxed services stop inside the sandbox and lose their 127.0.0.1 mappings too. */
    stopTicket: (store: Store, ticketId: number) => stopAllTicketServers(store, ticketId, ticketSandboxRunner(deps, ticketId)?.runner),
    hostPorts: (ticketId: number) => {
      const manifest = input.manifest();
      return manifest ? baselineHostPorts(manifest, ticketBaselineKeys(input.store, ticketId)) : [];
    },
    reattach: (ticketId: number, delayMs?: number) =>
      scheduleSandboxReattach(deps, input.store, input.manifest(), ticketId,
        (row) => isServing(`http://127.0.0.1:${row.port}/`), input.onError, delayMs),
  };
  return bindings;
}
