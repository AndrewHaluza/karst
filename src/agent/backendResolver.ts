import type { AgentBackend } from '../manifest/types.js';
import { sbxName } from './sbx/sbxName.js';
import { sbxPreflight, type SbxPreflight } from './sbx/sbxPreflight.js';
import { NODE_SBX_PROCESS, type SbxProcess } from './sbx/sbxProcess.js';
import { createSbxSessionRunner, SBX_CORES, type SbxCore } from './sbx/sbxRunner.js';
import { resolveDocker, type DockerResolveDeps } from './docker/resolveDocker.js';
import { HOST_SESSION_RUNNER, type SandboxTicketRef, type SessionRunner } from './sessionRunner.js';


export interface ResolveBackendInput {
  readonly backend: AgentBackend | undefined;
  readonly core: string;
  readonly projectRoot: string;
  readonly ticketId: number;
  readonly proc?: SbxProcess;
  readonly preflight?: (proc: SbxProcess) => Promise<SbxPreflight>;
  readonly host?: SessionRunner;
  /** The ticket worktree and branch; the docker backend clones it. */
  readonly worktree?: SandboxTicketRef;
  readonly docker?: DockerResolveDeps;
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
  const backend = input.backend ?? 'host';
  if (backend === 'host') return onHost('agentBackend: host');
  if (backend === 'docker') {
    const docker = await resolveDocker({
      core: input.core, projectRoot: input.projectRoot, ticketId: input.ticketId, worktree: input.worktree,
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
  return {
    runner: createSbxSessionRunner({ proc, core: input.core, name, existing: check.existing }),
    line: `sbx (${name})`,
  };
}

function isSbxCore(core: string): core is SbxCore {
  return (SBX_CORES as readonly string[]).includes(core);
}
