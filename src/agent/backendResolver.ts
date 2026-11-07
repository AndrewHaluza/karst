import { sandboxAccountBlock } from './accounts/registry.js';
import { ACCOUNT_CORES, type AccountCore } from './accounts/types.js';
import { backendForCore, type AgentBackends } from './backendChoices.js';
import { prepareSbxClone, sbxCloneDir } from './sbx/sbxClone.js';
import { sbxName } from './sbx/sbxName.js';
import { sbxPreflight, type SbxPreflight } from './sbx/sbxPreflight.js';
import { NODE_SBX_PROCESS, type SbxProcess } from './sbx/sbxProcess.js';
import { access, writeFile } from 'node:fs/promises';
import { availableParallelism, totalmem } from 'node:os';
import { resolveSbxMemory } from './sbx/sbxMemory.js';
import { resolveSbxLimits, type SandboxLimitsConfig } from './sbx/sbxLimits.js';
import type { SandboxMemoryConfig } from './docker/dockerMemory.js';
import { createSbxSessionRunner, SBX_CORES, type SbxCore } from './sbx/sbxRunner.js';
import { resolveDocker, type DockerResolveDeps } from './docker/resolveDocker.js';
import { HOST_SESSION_RUNNER, type SandboxTicketRef, type SessionRunner } from './sessionRunner.js';


export interface ResolveBackendInput {
  /** The per-core map; the session core's entry decides (absent → host). */
  readonly backends: AgentBackends | undefined;
  readonly core: string;
  readonly projectRoot: string;
  readonly ticketId: number;
  readonly proc?: SbxProcess;
  readonly preflight?: (proc: SbxProcess) => Promise<SbxPreflight>;
  readonly host?: SessionRunner;
  /** The ticket worktree and branch; the docker backend clones it. */
  readonly worktree?: SandboxTicketRef;
  readonly bridgeDir?: string;
  readonly docker?: DockerResolveDeps;
  /** The manifest's `sandboxMemory`: `sbxMemory` overrides the default sbx ceiling. */
  readonly sandboxMemory?: SandboxMemoryConfig;
  /** The manifest's `sandboxLimits`: sbx `--cpus`, worker opt-out. */
  readonly sandboxLimits?: SandboxLimitsConfig;
  /** Host CPU count (tests); default `os.availableParallelism()`. */
  readonly hostCpus?: number;
  /** Host RAM in bytes (tests); default `os.totalmem()`. */
  readonly hostRamBytes?: number;
  /** Karst log sink for the sbx runner (damaged-disk EXT4 lines). */
  readonly log?: (line: string) => void;
  /** The agent account the launch runs under; absent = the active account (@arch:AC-55). */
  readonly account?: string;
}

export interface ResolvedBackend {
  readonly runner: SessionRunner;
  /** One diagnostics line: `sbx (<name>)`, `docker (<container>)` or `host (<reason>)`. */
  readonly line: string;
}

/**
 * The only place that picks a session runner. Fails closed (arch:AC-31): any
 * reason a sandbox cannot be used resolves to the host runner — prompted, no bypass —
 * with that reason. Never throws.
 */
export async function resolveBackend(input: ResolveBackendInput): Promise<ResolvedBackend> {
  const host = input.host ?? HOST_SESSION_RUNNER;
  const onHost = (reason: string): ResolvedBackend => ({ runner: host, line: `host (${reason})` });
  const backend = backendForCore(input.backends, input.core);
  if (backend === 'host') return onHost(`agentBackends.${input.core}: host`);
  // @arch:AC-55: a command account is a host binary; a sandbox cannot run it.
  const accountBlock = (ACCOUNT_CORES as readonly string[]).includes(input.core)
    ? sandboxAccountBlock(input.core as AccountCore, input.account)
    : undefined;
  if (accountBlock) return onHost(accountBlock);
  if (backend === 'docker') {
    const docker = await resolveDocker({
      core: input.core, projectRoot: input.projectRoot, ticketId: input.ticketId, worktree: input.worktree,
      bridgeDir: input.bridgeDir,
      ...(input.account !== undefined ? { account: input.account } : {}),
      ...(input.docker ? { deps: input.docker } : {}),
    });
    return docker.ok ? { runner: docker.runner, line: `docker (${docker.names.container})` } : onHost(docker.reason);
  }
  if (!isSbxCore(input.core)) return onHost(`${input.core}: sbx backend unsupported`);
  let name: string;
  try {
    name = sbxName({ projectRoot: input.projectRoot, ticketId: input.ticketId, core: input.core });
  } catch (err) {
    return onHost(err instanceof Error ? err.message : String(err));
  }
  const proc = input.proc ?? NODE_SBX_PROCESS;
  const check = await (input.preflight ?? sbxPreflight)(proc);
  if (!check.ok) return onHost(check.reason);
  const cloneDir = sbxCloneDir(input.projectRoot, name);
  if (!check.existing.includes(name)) {
    // sbx refuses `--clone` from a linked worktree: fail closed before the terminal opens.
    if (!input.worktree?.branch) return onHost('sbx: no ticket worktree branch to clone');
    const cloned = await prepareSbxClone(proc, { worktree: input.worktree.hostWorktreePath, branch: input.worktree.branch, dir: cloneDir })
      .catch((err: unknown) => ({ ok: false as const, reason: `sandbox clone failed: ${err instanceof Error ? err.message : String(err)}` }));
    if (!cloned.ok) return onHost(cloned.reason);
  }
  const memory = resolveSbxMemory(input.hostRamBytes ?? totalmem(), input.sandboxMemory?.sbxMemory);
  await noteSandboxWithoutLimit(check.existing.includes(name), `${cloneDir}.sbx-memory`, name, memory, input.log);
  return {
    runner: createSbxSessionRunner({ proc, core: input.core, name, existing: check.existing, cloneDir, memory, ...resolveSbxLimits(input.hostCpus ?? availableParallelism(), input.sandboxLimits), ...(input.log ? { log: input.log } : {}) }),
    line: `sbx (${name})`,
  };
}

function isSbxCore(core: string): core is SbxCore {
  return (SBX_CORES as readonly string[]).includes(core);
}

/**
 * `--memory` applies only when sbx creates a sandbox. A marker beside the clone records that karst created it with a limit;
 * an existing sandbox without one keeps its old size, so say once per launch how to get the limit.
 */
async function noteSandboxWithoutLimit(exists: boolean, marker: string, name: string, memory: string, log?: (line: string) => void): Promise<void> {
  try {
    if (!exists) {
      await writeFile(marker, `${memory}\n`);
    } else if (!(await access(marker).then(() => true, () => false))) {
      log?.(`[sbx ${name}] created without a karst memory limit and keeps its old size; remove it (sbx rm ${name}) to get the ${memory} limit on the next launch`);
    }
  } catch {
    /* the marker is advisory */
  }
}
