import type { AgentBackend } from '../../manifest/types.js';
import { resolveBackend, type ResolvedBackend } from '../../agent/backendResolver.js';
import { sbxName } from '../../agent/sbx/sbxName.js';
import { NODE_SBX_PROCESS, type SbxProcess } from '../../agent/sbx/sbxProcess.js';
import { createSbxSessionRunner, SBX_CORES, type SbxCore } from '../../agent/sbx/sbxRunner.js';
import type { Notify } from './notify.js';

export interface BackendSessionInput {
  readonly backend: AgentBackend | undefined;
  readonly core: string;
  readonly projectRoot: string;
  readonly ticketId: number;
  readonly ticketLabel: string;
  readonly info: (line: string) => void;
  readonly resolve?: typeof resolveBackend;
}

/**
 * The `openSession` options for the manifest's `agentBackend` (arch:AC-32).
 * Absent → no options at all, so a host launch is byte-identical to before.
 */
export function backendSessionOptions(input: BackendSessionInput): {
  resolveRunner?: () => Promise<ResolvedBackend>;
  onBackend?: (line: string) => void;
} {
  if (input.backend === undefined) return {};
  const resolve = input.resolve ?? resolveBackend;
  return {
    resolveRunner: () =>
      resolve({ backend: input.backend, core: input.core, projectRoot: input.projectRoot, ticketId: input.ticketId }),
    onBackend: (line) => input.info(`[session] ticket ${input.ticketLabel} backend: ${line}`),
  };
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
  if (!isSbxCore(target.core)) {
    await deps.notify.error(`Karst: ${target.ticketLabel} has no sbx sandbox (core ${target.core ?? 'unknown'}).`);
    return false;
  }
  const name = sbxName({ projectRoot: deps.projectRoot, ticketId: target.ticketId, core: target.core });
  const runner = createSbxSessionRunner({ proc: deps.proc ?? NODE_SBX_PROCESS, core: target.core, name, existing: [] });
  const result = await runner.sync!({ hostWorktreePath: target.worktree.path, branch: target.worktree.branch });
  if (!result.ok) {
    await deps.notify.error(`Karst: sandbox sync for ${target.ticketLabel} failed: ${result.reason}`);
    return false;
  }
  deps.notify.info(`Karst: ${target.ticketLabel} ${result.summary}.`);
  return true;
}

function isSbxCore(core: string | null): core is SbxCore {
  return core !== null && (SBX_CORES as readonly string[]).includes(core);
}
