import { dirname } from 'node:path';
import { listProjectSandboxes, type ProjectSandbox, type SandboxInventory } from '../../agent/sandboxInventory.js';
import { SBX_CORES } from '../../agent/sbx/sbxRunner.js';
import { NODE_SBX_PROCESS } from '../../agent/sbx/sbxProcess.js';
import { isDockerCore } from '../../agent/docker/dockerImage.js';
import { NODE_DOCKER_PROCESS } from '../../agent/docker/dockerProcess.js';
import { ensureSandboxSynced, sandboxRunnerFor, type SandboxSyncDeps, type SandboxSyncTarget } from './sandboxSyncOps.js';

/** A modal choice; `undefined` = dismissed (treated as the safe default). */
export type Choose = (message: string, choices: readonly string[]) => Promise<string | undefined>;

export const OPEN_SYNC_DIFF = 'Open sync diff';
export const REMOVE_ANYWAY = 'Remove anyway';
export const CANCEL = 'Cancel';
export const REMOVE_ORPHANS = 'Remove orphan sandboxes';

export interface SandboxLifecycleDeps extends SandboxSyncDeps {
  readonly choose: Choose;
  /** Window ownership (arch:GLOBAL): only the owner stops/removes/adopts a ticket's sandbox. */
  readonly owns: (ticketId: number) => boolean;
  /** `undefined` until the hook endpoint is bound; no bridge dir to remove then. */
  readonly bridges?: { dispose(ticketId: number): Promise<void>; retryPending?(ticketId: number): Promise<void> };
  readonly openSyncDiff: (target: SandboxSyncTarget) => Promise<void>;
}

export type BackendKind = 'host' | 'sbx' | 'docker';

/** Where a core's session runs when a sandbox backend is configured. */
export function backendKindOf(core: string | null): BackendKind {
  const c = core ?? '';
  if ((SBX_CORES as readonly string[]).includes(c)) return 'sbx';
  return isDockerCore(c) ? 'docker' : 'host';
}

/** This project's sandboxes through the same process seams the runners use. */
export function inventoryOf(deps: SandboxSyncDeps): Promise<SandboxInventory> {
  return listProjectSandboxes({
    projectRoot: deps.projectRoot, sbx: deps.proc ?? NODE_SBX_PROCESS, docker: deps.dockerProc ?? NODE_DOCKER_PROCESS,
  });
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Ask before losing sandbox commits; default (dismiss) = cancel. */
async function confirmUnsynced(deps: SandboxLifecycleDeps, target: SandboxSyncTarget, reason: string): Promise<boolean> {
  const choice = await deps.choose(
    `Karst: the sandbox of ${target.ticketLabel} has commits that could not be synced (${reason}). Removing it loses them.`,
    [OPEN_SYNC_DIFF, REMOVE_ANYWAY, CANCEL],
  );
  if (choice === REMOVE_ANYWAY) return true;
  if (choice === OPEN_SYNC_DIFF) await deps.openSyncDiff(target);
  return false;
}

/**
 * Remove a ticket's sandbox after syncing it (archive, provider switch). A
 * missing sandbox is a no-op; an unsynced one is removed only on the user's
 * explicit choice. `false` = the caller must not go on (blocked or failed).
 */
export async function removeSandboxGuarded(
  deps: SandboxLifecycleDeps,
  target: SandboxSyncTarget,
  /** `skipSync`: the commits already reached the host another way (carry), so the pre-remove sync would only fail as diverged. */
  opts: { readonly skipSync?: boolean } = {},
): Promise<boolean> {
  if (backendKindOf(target.core) === 'host') return true;
  if (!deps.owns(target.ticketId)) {
    deps.notify.warn(`Karst: ${target.ticketLabel} is owned by another window; its sandbox was left alone.`);
    return false;
  }
  const inv = await inventoryOf(deps);
  const live = inv.sandboxes.some((s) => s.ticketId === target.ticketId && s.core === target.core);
  if (!live && inv.errors.length === 0) return true;
  // A non-host core always has a sandbox runner with sync + dispose.
  const runner = sandboxRunnerFor(deps, target.core, target.ticketId)!;
  const branch = target.worktree?.branch;
  const ref = { hostWorktreePath: target.worktree?.path ?? dirname(deps.projectRoot), branch: branch ?? '' };
  const synced = opts.skipSync ? { ok: true as const } : branch ? await runner.sync!(ref) : { ok: false as const, reason: 'no worktree branch to sync into' };
  if (!synced.ok && !(await confirmUnsynced(deps, target, synced.reason))) {
    deps.notify.warn(`Karst: kept the sandbox of ${target.ticketLabel}.`);
    return false;
  }
  try {
    await runner.dispose!(ref);
    await deps.bridges?.dispose(target.ticketId);
  } catch (err) {
    await deps.notify.error(`Karst: removing the sandbox for ${target.ticketLabel} failed: ${message(err)}`);
    return false;
  }
  deps.notify.info(`Karst: ${target.ticketLabel} sandbox removed.`);
  return true;
}

/**
 * Ticket done or session idle: sync, then stop (never remove) the owner's
 * sandbox (arch:AC-37). A failed sync only warns: stopping keeps the clone,
 * so no commit is lost. A good sync also retries a transiently failed marker.
 */
export async function stopSandboxOp(deps: SandboxLifecycleDeps, target: SandboxSyncTarget): Promise<boolean> {
  if (!deps.owns(target.ticketId)) return false;
  const runner = sandboxRunnerFor(deps, target.core, target.ticketId);
  if (!runner?.stop) return false;
  const synced = await ensureSandboxSynced(deps, target);
  if (synced.ok) void deps.bridges?.retryPending?.(target.ticketId);
  else deps.notify.warn(`Karst: ${target.ticketLabel} sandbox not synced before stop: ${synced.reason}`);
  try {
    await runner.stop();
    return true;
  } catch (err) {
    deps.notify.warn(`Karst: stopping the sandbox for ${target.ticketLabel} failed: ${message(err)}`);
    return false;
  }
}

/**
 * The ticket's core changed. The old core's sandbox is synced and removed
 * (guarded) and the stored provider session id
 * dropped, so a foreign id never reaches a different core.
 */
export async function switchProviderOp(
  deps: SandboxLifecycleDeps & { readonly clearSession: (ticketId: number) => void },
  target: SandboxSyncTarget,
  newCore: string,
): Promise<boolean> {
  if (target.core === newCore) return true;
  // The sandbox name carries the core, so ANY core change orphans the old one (sbx claude → codex too).
  if (!(await removeSandboxGuarded(deps, target))) return false;
  deps.clearSession(target.ticketId);
  return true;
}

export interface ReconcileTicket {
  readonly id: number;
  readonly sessionId: string | null;
  readonly sessionProvider: string | null;
}

export interface ReconcileResult {
  readonly running: readonly number[];
  readonly stopped: readonly number[];
  /** Owned sandboxed tickets whose sandbox is gone: their session id was dropped. */
  readonly missing: readonly number[];
  readonly orphans: readonly ProjectSandbox[];
}

/**
 * Activation recovery (arch:AC-32). Running sandboxes are adopted on the next
 * open (preflight lists them, so the runner reattaches by name, never creates a
 * duplicate); stopped ones stay stopped; a missing one gets a fresh provider
 * session. A runner whose listing failed proves nothing missing. Another
 * window's tickets are left alone; sandboxes with no live ticket are orphans.
 */
export function reconcileSandboxes(
  inv: SandboxInventory,
  live: readonly ReconcileTicket[],
  owns: (ticketId: number) => boolean,
  clearSession: (ticketId: number) => void,
): ReconcileResult {
  const liveIds = new Set(live.map((t) => t.id));
  const listed = (kind: BackendKind): boolean => !inv.errors.some((e) => e.startsWith(kind === 'sbx' ? 'sbx ' : 'docker '));
  const running: number[] = [], stopped: number[] = [], missing: number[] = [];
  for (const t of live) {
    if (!owns(t.id)) continue;
    const box = inv.sandboxes.find((s) => s.ticketId === t.id && s.core === t.sessionProvider);
    if (box) (box.state === 'running' ? running : stopped).push(t.id);
    else {
      const kind = backendKindOf(t.sessionProvider);
      if (kind !== 'host' && t.sessionId !== null && listed(kind)) {
        clearSession(t.id);
        missing.push(t.id);
      }
    }
  }
  return { running, stopped, missing, orphans: inv.sandboxes.filter((s) => s.invalidCore === true || !liveIds.has(s.ticketId)) };
}

export interface IdleTicket {
  readonly id: number;
  readonly updatedAtMs: number;
  /** A terminal/session is open: never stopped under it. */
  readonly sessionOpen: boolean;
}

/**
 * Running sandboxes to stop for idleness: owned by this window, live ticket,
 * no open session, ticket untouched longer than the threshold. Stop, never remove.
 */
export function idleSandboxes(
  inv: SandboxInventory,
  tickets: readonly IdleTicket[],
  owns: (ticketId: number) => boolean,
  nowMs: number,
  thresholdMs: number,
): ProjectSandbox[] {
  const idle = new Set(tickets.filter((t) => !t.sessionOpen && nowMs - t.updatedAtMs > thresholdMs).map((t) => t.id));
  return inv.sandboxes.filter((s) => s.state === 'running' && idle.has(s.ticketId) && owns(s.ticketId));
}

/** A sandbox named for a core no runner hosts has no runner to dispose it: remove the named object directly. */
async function removeInvalidCoreSandbox(deps: SandboxLifecycleDeps, o: ProjectSandbox): Promise<void> {
  const out = o.runner === 'docker'
    ? await (deps.dockerProc ?? NODE_DOCKER_PROCESS).run('docker', ['rm', '--force', o.name])
    : await (deps.proc ?? NODE_SBX_PROCESS).run('sbx', ['rm', '--force', o.name]);
  if (out.code !== 0) throw new Error(out.stderr.trim() || `rm exited ${out.code}`);
}

/** `karst.sandbox.cleanupOrphans`: remove this project's orphan sandboxes, only on confirmation. */
export async function cleanupOrphansOp(deps: SandboxLifecycleDeps, liveTicketIds: ReadonlySet<number>): Promise<number> {
  const inv = await inventoryOf(deps);
  const orphans = inv.sandboxes.filter((s) => s.invalidCore === true || !liveTicketIds.has(s.ticketId));
  if (orphans.length === 0) {
    deps.notify.info('Karst: no orphan sandboxes.');
    return 0;
  }
  const choice = await deps.choose(
    `Karst: remove ${orphans.length} orphan sandbox(es) of this project? ${orphans.map((o) => o.name).join(', ')}`,
    [REMOVE_ORPHANS, CANCEL],
  );
  if (choice !== REMOVE_ORPHANS) return 0;
  let removed = 0;
  for (const o of orphans) {
    try {
      if (o.invalidCore) await removeInvalidCoreSandbox(deps, o);
      else await sandboxRunnerFor(deps, o.core, o.ticketId)!.dispose!({ hostWorktreePath: dirname(deps.projectRoot), branch: '' });
      removed += 1;
    } catch (err) {
      deps.notify.warn(`Karst: removing orphan sandbox ${o.name} failed: ${message(err)}`);
    }
  }
  deps.notify.info(`Karst: removed ${removed} orphan sandbox(es).`);
  return removed;
}
