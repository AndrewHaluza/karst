import { backendForCore, type AgentBackends } from './backendChoices.js';
import { prepareSbxClone, sbxCloneDir } from './sbx/sbxClone.js';
import { sbxName } from './sbx/sbxName.js';
import { sbxPreflight, type SbxPreflight } from './sbx/sbxPreflight.js';
import { NODE_SBX_PROCESS, type SbxProcess } from './sbx/sbxProcess.js';
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
  /** Karst log sink for the sbx runner (damaged-disk EXT4 lines). */
  readonly log?: (line: string) => void;
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
  if (backend === 'docker') {
    const docker = await resolveDocker({
      core: input.core, projectRoot: input.projectRoot, ticketId: input.ticketId, worktree: input.worktree,
      bridgeDir: input.bridgeDir,
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
  return {
    runner: createSbxSessionRunner({ proc, core: input.core, name, existing: check.existing, cloneDir, ...(input.log ? { log: input.log } : {}) }),
    line: `sbx (${name})`,
  };
}

function isSbxCore(core: string): core is SbxCore {
  return (SBX_CORES as readonly string[]).includes(core);
}
