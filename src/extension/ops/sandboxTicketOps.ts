import type { Manifest } from '../../manifest/types.js';
import { backendForCore, selectedSandboxBackends, type AgentBackends } from '../../agent/backendChoices.js';
import type { Store } from '../../store/db.js';
import { bridgePaths, type BridgePaths } from '../../agent/bridge/bridgeDir.js';
import { isDockerCore } from '../../agent/docker/dockerImage.js';
import { dockerNames } from '../../agent/docker/dockerNames.js';
import { NODE_DOCKER_PROCESS, type DockerProcess } from '../../agent/docker/dockerProcess.js';
import { createDockerSessionRunner } from '../../agent/docker/dockerRunner.js';
import { linuxUser } from '../../agent/docker/resolveDocker.js';
import { sbxName } from '../../agent/sbx/sbxName.js';
import { NODE_SBX_PROCESS, type SbxProcess } from '../../agent/sbx/sbxProcess.js';
import { sbxCloneDir } from '../../agent/sbx/sbxClone.js';
import { createSbxSessionRunner, SBX_CORES } from '../../agent/sbx/sbxRunner.js';
import { listProjectSandboxes, type ProjectSandbox } from '../../agent/sandboxInventory.js';
import { pickTicketSandbox } from '../../agent/sandboxLookup.js';
import { allowBaselineHostPorts, baselineHostPorts, ticketBaselineKeys } from '../../agent/sandboxHostAllow.js';
import { resetSandboxServices, reverifySandboxServices, stopAllTicketServers, type ReverifyResult } from '../../agent/sandboxServices.js';
import { createUserUatGate } from '../../agent/userUatGate.js';
import { unitByKey } from '../../manifest/runnable.js';
import type { SessionRunner } from '../../agent/sessionRunner.js';
import type { SandboxServiceContext } from '../../runtime/startService.js';
import { runProcess, type GateProcessRunner } from '../../workflow/gates/run.js';
import { isServing } from '../../runtime/health.js';

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
  readonly proc?: SbxProcess;
  readonly dockerProc?: DockerProcess;
  readonly platform?: NodeJS.Platform;
  readonly debug?: (message: string) => void;
}

export interface TicketSandbox {
  readonly runner: SessionRunner;
  readonly sandboxName: string;
}

/** The runner the backend would use for this ticket's core, or undefined (host). Sync: no probe. */
export function ticketSandboxRunner(deps: TicketSandboxDeps, ticketId: number, coreOverride?: string | null): TicketSandbox | undefined {
  const core = coreOverride === undefined ? deps.coreOf(ticketId) : coreOverride;
  if (core === null) return undefined;
  const backend = backendForCore(deps.backends(), core);
  const bridge = deps.bridgeOf?.(ticketId);
  const projectRoot = deps.projectRoot(ticketId);
  if (backend === 'sbx' && (SBX_CORES as readonly string[]).includes(core)) {
    const name = sbxName({ projectRoot, ticketId, core });
    const runner = createSbxSessionRunner({
      proc: deps.proc ?? NODE_SBX_PROCESS, core: core as 'claude' | 'codex', name, existing: [], cloneDir: sbxCloneDir(projectRoot, name),
      ...(bridge ? { evidenceDir: bridge.dir } : {}),
    });
    return { runner, sandboxName: name };
  }
  if (backend === 'docker' && isDockerCore(core)) {
    const names = dockerNames({ projectRoot, ticketId, core });
    const runner = createDockerSessionRunner({
      proc: deps.dockerProc ?? NODE_DOCKER_PROCESS, core, names,
      user: linuxUser(deps.platform ?? process.platform, process.getuid?.(), process.getgid?.()),
      ...(bridge ? { evidenceDir: bridge.runDir } : {}),
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
}

/** The ticket's sandbox from the listing first, `sessionProvider` as the hint (F4). Never throws. */
export async function resolveTicketSandbox(deps: TicketSandboxDeps, ticketId: number): Promise<ResolvedTicketSandbox> {
  const hint = deps.coreOf(ticketId);
  let listed: ProjectSandbox | undefined;
  if (deps.inventory) {
    const all = await deps.inventory(ticketId).catch((err: unknown) => {
      deps.debug?.(`[sandbox] ticket ${ticketId}: listing failed (${err instanceof Error ? err.message : String(err)}); using the session provider`);
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
  return { found, listed };
}

/** The services context, only when the sandbox exists. */
export async function ticketSandboxContext(deps: TicketSandboxDeps, ticketId: number): Promise<SandboxServiceContext | undefined> {
  const { found, listed } = await resolveTicketSandbox(deps, ticketId);
  if (!found || !(listed || (await found.runner.hasSandbox?.()))) return undefined;
  return { runner: found.runner, sandboxName: found.sandboxName };
}

/**
 * The ticket's gate boundary: inside its sandbox when it exists, else the host
 * `runProcess`. A ticket that HAS a sandbox never runs a gate on the host: with
 * no runner able to exec there, the gate is refused (`spawnFailed`, no verdict;
 * arch:AC-31/AC-32). Undefined when no sandbox backend is configured and the
 * session provider names no sandboxed core, so host tickets stay byte-identical.
 */
export function ticketGateProcess(deps: TicketSandboxDeps, ticketId: number): GateProcessRunner | undefined {
  const legacy = ticketSandboxRunner(deps, ticketId);
  const listing = deps.inventory !== undefined && selectedSandboxBackends(deps.backends()).length > 0;
  if (!listing && !legacy?.runner.runGate) return undefined;
  return async (command, args, cwd, options) => {
    const { found, listed } = await resolveTicketSandbox(deps, ticketId);
    const sandboxGate = found?.runner.runGate;
    if (listed && !sandboxGate) {
      const reason = `gate refused: ticket ${ticketId} has a sandbox (${listed.name}) but no runner can execute gates there; gates never run on the host for a sandboxed ticket`;
      deps.debug?.(`[gate] ${reason}`);
      return { kind: 'spawnFailed', message: reason, output: reason };
    }
    const inside = sandboxGate !== undefined && (listed !== undefined || (await found!.runner.hasSandbox?.()) === true);
    deps.debug?.(`[gate] ticket ${ticketId}: ${command} runs ${inside ? `in ${found!.runner.kind} (${found!.sandboxName})` : 'on the host (no sandbox)'}`);
    return inside ? sandboxGate!(command, args, cwd, options) : runProcess(command, args, cwd, options);
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
  if (!allow.ok) deps.debug?.(`[runtime] ticket ${ticketId}: baseline allow failed: ${allow.reason}`);
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
): (store: S, manifest: M, ticketId: number, hot: string[], opts?: O) => Promise<R> {
  return async (store, manifest, ticketId, hot, opts) => {
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
}

/** Everything extension.ts binds for sandboxed tickets (arch:AC-32), so the host file stays bindings-only. */
export function createTicketSandboxBindings(input: TicketSandboxBindingsInput) {
  const cores = new Map<number, string>();
  const deps: TicketSandboxDeps = {
    ...input,
    // The listing's answer wins over the (possibly null) session provider for every sync reader too.
    coreOf: (ticketId) => cores.get(ticketId) ?? input.coreOf(ticketId),
    inventory: input.inventory ?? (async (ticketId) => (await listProjectSandboxes({
      projectRoot: input.projectRoot(ticketId), sbx: input.proc ?? NODE_SBX_PROCESS, docker: input.dockerProc ?? NODE_DOCKER_PROCESS,
    })).sandboxes),
    remember: (ticketId, core) => { if (core === null) cores.delete(ticketId); else cores.set(ticketId, core); },
    bridgeOf: (ticketId) => {
      const root = input.bridgeRoot();
      return root === undefined ? undefined : bridgePaths(root, ticketId);
    },
  };
  const uatGate = createUserUatGate();
  return {
    deps,
    /** Decision 7: open/copy of a ticket's service link is withheld during agent UAT. */
    userUatWithheld: (ticketId: number) => uatGate.isWithheld(ticketId),
    /** Decisions 7-8 for the UAT stage: keep a sandboxed stack, reset it, gate the link. */
    userUat: {
      // Only a stack that really runs in the sandbox: a host fallback is stopped as before.
      keepStackForUserUat: (ticketId: number) =>
        ticketSandboxRunner(deps, ticketId) !== undefined &&
        input.store.db.prepare("SELECT 1 FROM servers WHERE ticket_id = ? AND status = 'running' AND sandbox IS NOT NULL").get(ticketId) !== undefined,
      prepareUserUat: async (store: Store, ticketId: number): Promise<string[]> => {
        const found = ticketSandboxRunner(deps, ticketId);
        const manifest = input.manifest();
        if (!found || !manifest) return [];
        return resetSandboxServices(store, ticketId, found.runner, (key) => unitByKey(manifest, key)?.def);
      },
      agentUatPhase: (ticketId: number, phase: 'start' | 'end') => {
        if (phase === 'start') uatGate.withhold(ticketId);
        else uatGate.release(ticketId);
      },
    },
    gateProcessFor: (ticketId: number) => ticketGateProcess(deps, ticketId),
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
}
