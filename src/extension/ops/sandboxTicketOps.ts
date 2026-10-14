import type { AgentBackend, Manifest } from '../../manifest/types.js';
import type { Store } from '../../store/db.js';
import { bridgePaths, type BridgePaths } from '../../agent/bridge/bridgeDir.js';
import { isDockerCore } from '../../agent/docker/dockerImage.js';
import { dockerNames } from '../../agent/docker/dockerNames.js';
import { NODE_DOCKER_PROCESS, type DockerProcess } from '../../agent/docker/dockerProcess.js';
import { createDockerSessionRunner } from '../../agent/docker/dockerRunner.js';
import { linuxUser } from '../../agent/docker/resolveDocker.js';
import { sbxName } from '../../agent/sbx/sbxName.js';
import { NODE_SBX_PROCESS, type SbxProcess } from '../../agent/sbx/sbxProcess.js';
import { createSbxSessionRunner, SBX_CORES } from '../../agent/sbx/sbxRunner.js';
import { allowBaselineHostPorts, baselineHostPorts, ticketBaselineKeys } from '../../agent/sandboxHostAllow.js';
import { reverifySandboxServices, stopAllTicketServers, type ReverifyResult } from '../../agent/sandboxServices.js';
import type { SessionRunner } from '../../agent/sessionRunner.js';
import type { SandboxServiceContext } from '../../runtime/startService.js';
import { runProcess, type GateProcessRunner } from '../../workflow/gates/run.js';
import { isServing } from '../../runtime/health.js';

/**
 * Per-ticket sandbox lookups for services and gates (arch:AC-32). A ticket is
 * sandboxed only when the manifest's `agentBackend` hosts its session core
 * (sbx: claude/codex, docker: opencode/opencode2) AND its sandbox exists — a
 * session that failed closed to the host has none, so it keeps today's host
 * services and gates. No `vscode` import (ops ratchet).
 */
export interface TicketSandboxDeps {
  readonly backend: () => AgentBackend | undefined;
  readonly projectRoot: () => string;
  /** The ticket's session core (`tickets.session_provider`), or null. */
  readonly coreOf: (ticketId: number) => string | null;
  /** The ticket's evidence bridge paths, when the hook endpoint is up. */
  readonly bridgeOf?: (ticketId: number) => BridgePaths | undefined;
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
export function ticketSandboxRunner(deps: TicketSandboxDeps, ticketId: number): TicketSandbox | undefined {
  const backend = deps.backend();
  const core = deps.coreOf(ticketId);
  if (core === null) return undefined;
  const bridge = deps.bridgeOf?.(ticketId);
  const projectRoot = deps.projectRoot();
  if (backend === 'sbx' && (SBX_CORES as readonly string[]).includes(core)) {
    const name = sbxName({ projectRoot, ticketId, core });
    const runner = createSbxSessionRunner({
      proc: deps.proc ?? NODE_SBX_PROCESS, core: core as 'claude' | 'codex', name, existing: [],
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

/** The services context, only when the sandbox exists. */
export async function ticketSandboxContext(deps: TicketSandboxDeps, ticketId: number): Promise<SandboxServiceContext | undefined> {
  const found = ticketSandboxRunner(deps, ticketId);
  if (!found || !(await found.runner.hasSandbox?.())) return undefined;
  return { runner: found.runner, sandboxName: found.sandboxName };
}

/**
 * The ticket's gate boundary: inside its sandbox when it exists, else the host
 * `runProcess` (zero behaviour change). Undefined when the backend never hosts
 * this core, so the stage deps stay byte-identical for host tickets.
 */
export function ticketGateProcess(deps: TicketSandboxDeps, ticketId: number): GateProcessRunner | undefined {
  const found = ticketSandboxRunner(deps, ticketId);
  if (!found?.runner.runGate) return undefined;
  const sandboxGate = found.runner.runGate;
  return async (command, args, cwd, options) => {
    const inside = (await found.runner.hasSandbox?.()) === true;
    deps.debug?.(`[gate] ticket ${ticketId}: ${command} runs ${inside ? `in ${found.runner.kind} (${found.sandboxName})` : 'on the host (no sandbox)'}`);
    return inside ? sandboxGate(command, args, cwd, options) : runProcess(command, args, cwd, options);
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
  if (!deps || !manifest || manifest.agentBackend === undefined || manifest.agentBackend === 'host') return false;
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
  const deps: TicketSandboxDeps = {
    ...input,
    bridgeOf: (ticketId) => {
      const root = input.bridgeRoot();
      return root === undefined ? undefined : bridgePaths(root, ticketId);
    },
  };
  return {
    deps,
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
