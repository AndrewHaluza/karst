import { SHELL_NO_SANDBOX } from '../../agent/sandboxShell.js';
import type { SandboxTicketRef } from '../../agent/sessionRunner.js';
import { sandboxRunnerFor, type SandboxSyncDeps, type SandboxSyncTarget } from './sandboxSyncOps.js';

/** What the host asks the editor to open: an integrated terminal that runs `cmd` (never a shell string). */
export interface ShellTerminalSpec {
  readonly name: string;
  readonly cmd: string;
  readonly args: readonly string[];
  readonly cwd: string;
}

export interface SandboxShellDeps extends SandboxSyncDeps {
  /** The VS Code binding: creates and shows the integrated terminal. */
  readonly openTerminal: (spec: ShellTerminalSpec) => void;
}

/** The dashboard's `DashboardSandboxView.shell`: the menu item is enabled only when `available`; `why` is its visible hint. */
export interface ShellAvailability {
  readonly available: boolean;
  readonly why: string | null;
}

const ref = (target: SandboxSyncTarget): SandboxTicketRef => ({ hostWorktreePath: target.worktree?.path ?? '', branch: target.worktree?.branch ?? '' });

/** Builds the shell command without opening anything; a runner that cannot answer is `ok: false` with its reason. */
async function resolveShell(deps: SandboxSyncDeps, target: SandboxSyncTarget) {
  const runner = sandboxRunnerFor(deps, target.core, target.ticketId);
  if (!runner?.shellCommand) return { ok: false as const, reason: SHELL_NO_SANDBOX };
  try {
    return await runner.shellCommand(ref(target));
  } catch (err) {
    return { ok: false as const, reason: `shell lookup failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export async function sandboxShellAvailability(deps: SandboxSyncDeps, target: SandboxSyncTarget): Promise<ShellAvailability> {
  const r = await resolveShell(deps, target);
  return r.ok ? { available: true, why: null } : { available: false, why: r.reason };
}

/**
 * Dashboard "Open shell in sandbox": a terminal named `Karst sandbox · <ticket key>` running the runner's shell
 * command. It inherits the sandbox's network policy and never touches the agent session (arch:AC-53).
 */
export async function openSandboxShellOp(deps: SandboxShellDeps, target: SandboxSyncTarget): Promise<boolean> {
  const r = await resolveShell(deps, target);
  if (!r.ok) {
    await deps.notify.error(`Karst: cannot open a shell in the ${target.ticketLabel} sandbox: ${r.reason}`);
    return false;
  }
  deps.openTerminal({ name: `Karst sandbox · ${target.ticketLabel}`, cmd: r.cmd, args: r.args, cwd: r.cwd ?? target.worktree?.path ?? deps.projectRoot });
  return true;
}

export interface ShellAvailabilityCacheOptions {
  readonly probe: (ticketId: number) => Promise<ShellAvailability>;
  /** Called when a probe changed the cached value, so the dashboard re-pushes its state. */
  readonly onChange: (ticketId: number) => void;
  readonly now?: () => number;
  readonly ttlMs?: number;
}

/** Until the first probe answers, the item is disabled with this hint. */
export const SHELL_CHECKING: ShellAvailability = { available: false, why: 'Checking sandbox' };
export const SHELL_CACHE_TTL_MS = 10_000;

/**
 * A sync reader for the (sync) dashboard state builder: returns the last probe and refreshes it in the background
 * when older than the TTL. One probe per ticket at a time; a probe that throws keeps the old value.
 */
export interface ShellAvailabilityCache {
  readonly read: (ticketId: number) => ShellAvailability;
  /** Mark a ticket's value stale (after Stop / Remove): the next read probes at once and keeps the old value until it answers. */
  readonly invalidate: (ticketId: number) => void;
}

export function createShellAvailabilityCache(opts: ShellAvailabilityCacheOptions): ShellAvailabilityCache {
  const now = opts.now ?? Date.now;
  const ttl = opts.ttlMs ?? SHELL_CACHE_TTL_MS;
  const cache = new Map<number, { value: ShellAvailability; at: number }>();
  const inflight = new Set<number>();
  const read = (ticketId: number): ShellAvailability => {
    const hit = cache.get(ticketId);
    if (hit && now() - hit.at < ttl) return hit.value;
    if (!inflight.has(ticketId)) {
      inflight.add(ticketId);
      void opts.probe(ticketId).then(
        (value) => {
          const before = cache.get(ticketId)?.value;
          cache.set(ticketId, { value, at: now() });
          if (before === undefined || before.available !== value.available || before.why !== value.why) opts.onChange(ticketId);
        },
        () => { if (hit) cache.set(ticketId, { ...hit, at: now() }); },
      ).finally(() => inflight.delete(ticketId));
    }
    return hit?.value ?? SHELL_CHECKING;
  };
  return { read, invalidate: (ticketId) => { const hit = cache.get(ticketId); if (hit) cache.set(ticketId, { ...hit, at: Number.NEGATIVE_INFINITY }); } };
}
