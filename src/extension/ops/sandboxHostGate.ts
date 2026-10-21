import { runProcess, type GateProcessRunner } from '../../workflow/gates/run.js';
import type { EnsureSyncResult } from './sandboxSyncOps.js';
import { resolveTicketSandbox, type TicketSandboxDeps } from './sandboxTicketOps.js';

const SHA = /^[0-9a-f]{40,64}$/;

export interface HostGateDeps {
  readonly sandbox: TicketSandboxDeps;
  /** Two-way sync (`ensureInSync`); a no-op when no sandbox is attached. */
  readonly sync: (ticketId: number) => Promise<EnsureSyncResult>;
  /** The host stopped the sandbox itself (arch:AC-37): a stopped sandbox is then expected, its state was synced first. */
  readonly hostEnded?: (ticketId: number) => boolean;
  /** Host git, for the dirty guard. Absent → real `git` via `runProcess`. */
  readonly git?: GateProcessRunner;
}

type Prepared = { readonly ok: true } | { readonly ok: false; readonly reason: string };

/**
 * Runs a `sandbox: host` gate for a sandboxed ticket (arch:AC-36 exception).
 * The first gate of a list verifies the host tree once (presence → sync →
 * dirty guard); every host gate of that list then runs in the host worktree.
 * A stopped sandbox is started first. Every refusal is `spawnFailed` (no
 * verdict), never an exit code; runGateList records it as capability-missing. No sandbox attached = a host ticket:
 * the gate just runs on the host, no sync.
 */
export function ticketHostGate(deps: HostGateDeps, ticketId: number, sandboxGate: GateProcessRunner | undefined): () => GateProcessRunner {
  return () => {
    let prepared: Promise<Prepared & { readonly sandboxed: boolean }> | undefined;
    return async (command, args, cwd, options) => {
      prepared ??= prepare(deps, ticketId, cwd, sandboxGate);
      const p = await prepared;
      if (!p.ok) {
        deps.sandbox.debug?.(`[gate] ticket ${ticketId}: host gate refused: ${p.reason}`);
        return { kind: 'spawnFailed', message: p.reason, output: p.reason };
      }
      deps.sandbox.debug?.(`[gate] ticket ${ticketId}: ${command} runs on the host${p.sandboxed ? ' after a verified sync' : ' (no sandbox)'}`);
      return runProcess(command, args, cwd, options);
    };
  };
}

async function prepare(deps: HostGateDeps, ticketId: number, cwd: string, sandboxGate: GateProcessRunner | undefined): Promise<Prepared & { readonly sandboxed: boolean }> {
  let { found, listed } = await resolveTicketSandbox(deps.sandbox, ticketId);
  if (listed?.state === 'stopped' && deps.hostEnded?.(ticketId) !== true) {
    // In-sandbox gates start a stopped sandbox via `exec`; do the same here with a no-op.
    const started = sandboxGate ? await sandboxGate('true', [], cwd, {}) : undefined;
    ({ found, listed } = await resolveTicketSandbox(deps.sandbox, ticketId));
    if (listed?.state !== 'running') {
      const why = started === undefined ? 'no runner can execute there' : started.output.trim() || started.kind;
      return refused(`sandbox could not be started: ${why}`);
    }
    deps.sandbox.debug?.(`[gate] ticket ${ticketId}: sandbox stopped, started for host gates`);
  }
  const attached = listed !== undefined || (found !== undefined && (await found.runner.hasSandbox?.().catch(() => false)) === true);
  if (!attached) return { ok: true, sandboxed: false };
  const synced = await deps.sync(ticketId);
  if (!synced.ok) return refused(`sandbox sync failed, host gates not run: ${synced.reason}`);
  const dirty = await dirtyGuard(deps, cwd, sandboxGate);
  return dirty === null ? { ok: true, sandboxed: true } : refused(dirty);
}

function refused(reason: string): Prepared & { readonly sandboxed: boolean } {
  return { ok: false, reason, sandboxed: true };
}

/** Null when the host worktree is clean and at the sandbox's HEAD; else the refusal reason. */
async function dirtyGuard(deps: HostGateDeps, cwd: string, sandboxGate: GateProcessRunner | undefined): Promise<string | null> {
  const git = deps.git ?? ((command, args, dir, options) => runProcess(command, args, dir, options));
  const hostHead = await headOf(git, cwd);
  const sandboxHead = sandboxGate ? await headOf(sandboxGate, cwd) : null;
  if (hostHead === null || sandboxHead === null) return 'host gates not run: cannot read the host or sandbox HEAD';
  if (hostHead !== sandboxHead) return `host gates not run: host HEAD ${hostHead.slice(0, 8)} differs from sandbox HEAD ${sandboxHead.slice(0, 8)}`;
  const status = await git('git', ['status', '--porcelain'], cwd, {});
  if (status.kind !== 'completed' || status.exitCode !== 0) return 'host gates not run: cannot read the host worktree status';
  return status.output.trim() === '' ? null : 'host gates not run: the host worktree has uncommitted changes';
}

async function headOf(run: GateProcessRunner, cwd: string): Promise<string | null> {
  const out = await run('git', ['rev-parse', 'HEAD'], cwd, {});
  if (out.kind !== 'completed' || out.exitCode !== 0) return null;
  const sha = out.output.trim().split(/\s+/).pop() ?? '';
  return SHA.test(sha) ? sha : null;
}
