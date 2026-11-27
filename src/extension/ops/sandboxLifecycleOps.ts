import { listProjectSandboxes, type ProjectSandbox, type SandboxInventory } from '../../agent/sandboxInventory.js';
import { plural, reasonText } from '../../model/notifyText.js';
import { SBX_CORES } from '../../agent/sbx/sbxRunner.js';
import { NODE_SBX_PROCESS } from '../../agent/sbx/sbxProcess.js';
import { isDockerCore } from '../../agent/docker/dockerImage.js';
import { NODE_DOCKER_PROCESS } from '../../agent/docker/dockerProcess.js';
import { disposeFailures, disposeResult, disposeStep, type DisposeResult } from '../../agent/disposeResult.js';
import type { SessionRunner, SandboxTicketRef } from '../../agent/sessionRunner.js';
import type { SbxGrantReleaser } from './sbxLaunchOauth.js';
import { ensureSandboxSynced, probeOf, sandboxRunnerFor, type SandboxSyncDeps, type SandboxSyncTarget } from './sandboxSyncOps.js';

/** A modal choice; `undefined` = dismissed (treated as the safe default). */
export type Choose = (message: string, choices: readonly string[]) => Promise<string | undefined>;

export const OPEN_SYNC_DIFF = 'Open sync diff';
export const RETRY_NOW = 'Retry now';
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
  /** Revoke the proxy key and remove the policy rule of an sbx sandbox that is removed by name (@arch:AC-51). */
  readonly releaseGrant?: SbxGrantReleaser;
  readonly debug?: (message: string) => void;
}

export type BackendKind = 'host' | 'sbx' | 'docker' | 'ssh';

/**
 * Which sandbox kind a core WOULD use when a sandbox backend is configured.
 * It never says where a ticket runs: only the recorded placement does (arch:AC-32).
 */
export function sandboxKindOfCore(core: string | null): BackendKind {
  const c = core ?? '';
  if ((SBX_CORES as readonly string[]).includes(c)) return 'sbx';
  return isDockerCore(c) ? 'docker' : 'host';
}

/**
 * Did the listing of this runner fail? Only the ticket's OWN runner counts (T801): `sbx `, `docker `,
 * or `ssh <remote>:` for one remote (any `ssh ` error when no remote is given). Host has no listing.
 */
export function listingFailedFor(errors: readonly string[], kind: BackendKind, remote?: string): boolean {
  if (kind === 'host') return false;
  const prefix = kind === 'ssh' ? (remote === undefined ? 'ssh ' : `ssh ${remote}:`) : `${kind} `;
  return errors.some((e) => e.startsWith(prefix));
}

/** This project's sandboxes through the same process seams the runners use. */
export function inventoryOf(deps: Pick<SandboxSyncDeps, 'projectRoot' | 'proc' | 'dockerProc'>): Promise<SandboxInventory> {
  return listProjectSandboxes({
    projectRoot: deps.projectRoot, sbx: deps.proc ?? NODE_SBX_PROCESS, docker: deps.dockerProc ?? NODE_DOCKER_PROCESS,
  });
}

/**
 * The one removal path: dispose, then re-list the inventory. A sandbox still
 * listed after a clean dispose is a failed removal (a daemon that swallowed the
 * rm). Callers keep the bridge dir and clone record on `ok: false`.
 */
export async function removeVerified(
  deps: SandboxLifecycleDeps,
  dispose: () => Promise<DisposeResult>,
  stillListed: (s: ProjectSandbox) => boolean,
): Promise<DisposeResult> {
  const result = await dispose();
  if (!result.ok) return result;
  const inv = await inventoryOf(deps);
  if (!inv.sandboxes.some(stillListed)) return result;
  return disposeResult([...result.steps, { step: 'inventory', status: 'failed', stderr: 'still listed after removal' }]);
}

/** The ssh removal path: no listing shows ssh sandboxes, so the runner's own probe verifies the removal (D826). */
async function removeSshVerified(runner: SessionRunner, ref: SandboxTicketRef): Promise<DisposeResult> {
  const result = await runner.dispose!(ref);
  if (!result.ok) return result;
  const probe = await probeOf(runner);
  if (probe.state === 'absent') return result;
  const stderr = probe.state === 'unknown' ? `removal not verified: ${probe.reason}` : 'still present after removal';
  return disposeResult([...result.steps, { step: 'probe', status: 'failed', stderr }]);
}

function removeRunner(deps: SandboxLifecycleDeps, runner: SessionRunner, ref: SandboxTicketRef, stillListed: (s: ProjectSandbox) => boolean): Promise<DisposeResult> {
  return removeVerified(deps, () => runner.dispose!(ref), stillListed);
}

/** Ask before losing sandbox commits; default (dismiss) = cancel. */
async function confirmUnsynced(deps: SandboxLifecycleDeps, target: SandboxSyncTarget, reason: string): Promise<boolean> {
  const choice = await deps.choose(
    `The sandbox of ${target.ticketLabel} has commits that did not sync (${reason}). Removing the sandbox loses them.`,
    [OPEN_SYNC_DIFF, REMOVE_ANYWAY, CANCEL],
  );
  if (choice === REMOVE_ANYWAY) return true;
  if (choice === OPEN_SYNC_DIFF) await deps.openSyncDiff(target);
  return false;
}

/**
 * Remove every sandbox of a ticket (any core, any backend) after syncing each
 * (archive, provider switch, hard delete). No sandbox is a no-op; an unsynced
 * one is removed only on the user's explicit choice. `false` = the caller must
 * not go on (blocked or failed).
 */
export async function removeSandboxGuarded(
  deps: SandboxLifecycleDeps,
  target: SandboxSyncTarget,
  /** `skipSync`: the commits already reached the host another way (carry), so the pre-remove sync would only fail as diverged. */
  opts: { readonly skipSync?: boolean } = {},
): Promise<boolean> {
  const inv = await inventoryOf(deps);
  const boxes = inv.sandboxes.filter((s) => s.ticketId === target.ticketId);
  const placement = deps.placementOf(target.ticketId);
  // No listing shows an ssh sandbox: the recorded placement names it, and its runner's probe decides (D826).
  if (placement?.backend === 'ssh') {
    // Stryker disable next-line StringLiteral,LogicalOperator: equivalent, the placement's ssh runner removes it and reads none of these fields
    boxes.push({ runner: 'ssh', name: placement.sandboxName ?? '', ticketId: target.ticketId, core: placement.core ?? target.core ?? '', state: 'stopped' });
  }
  // A failed listing proves nothing gone: fall back to the recorded placement, else the ticket's current core. Callers skip a recorded-host ticket first (arch:AC-32).
  const kind = placement?.backend ?? sandboxKindOfCore(target.core);
  // An ssh placement always pushed its box above, so `kind` is never ssh here.
  if (boxes.length === 0 && kind !== 'host' && inv.errors.length > 0) {
    // Stryker disable next-line StringLiteral: equivalent, the removal reads only the runner and core of a fallback box
    boxes.push({ runner: kind, name: '', ticketId: target.ticketId, core: target.core!, state: 'stopped' });
  }
  if (boxes.length === 0) return true;
  if (!deps.owns(target.ticketId)) {
    deps.notify.warn(`The sandbox of ${target.ticketLabel} stays. Another window owns the ticket.`);
    return false;
  }
  for (const box of boxes) {
    if (!(await removeOneGuarded(deps, { ...target, core: box.core }, box, opts))) return false;
  }
  try {
    await deps.bridges?.dispose(target.ticketId);
  } catch (err) {
    await deps.notify.error(`The sandbox of ${target.ticketLabel} was not removed: ${reasonText(err)}`);
    return false;
  }
  deps.notify.info(`Removed the sandbox of ${target.ticketLabel}.`);
  return true;
}

/** The deps for a listed sbx or docker box: no placement, so its own runner removes it (D826). */
function listedBoxDeps(deps: SandboxLifecycleDeps): SandboxLifecycleDeps {
  // Stryker disable next-line ArrowFunction: equivalent, sandboxRunnerFor reads only `placement?.backend`
  return { ...deps, placementOf: () => null };
}

async function removeOneGuarded(
  deps: SandboxLifecycleDeps,
  target: SandboxSyncTarget,
  box: ProjectSandbox,
  opts: { readonly skipSync?: boolean },
): Promise<boolean> {
  const branch = target.worktree?.branch;
  const ref = { hostWorktreePath: target.worktree?.path ?? '', branch: branch ?? '' };
  try {
    if (box.invalidCore) {
      await removeInvalidCoreSandbox(deps, box);
      return true;
    }
    // A listed sbx or docker box is removed by its own runner, even when the placement says ssh (a box left from before).
    const runner = sandboxRunnerFor(box.runner === 'ssh' ? deps : listedBoxDeps(deps), target.core, target.ticketId);
    if (!runner) return true;
    if (box.runner === 'ssh') {
      const probe = await probeOf(runner);
      if (probe.state === 'absent') return true;
    }
    const synced = opts.skipSync ? { ok: true as const } : branch ? await runner.sync!(ref) : { ok: false as const, reason: 'no worktree branch to sync into' };
    if (!synced.ok && !(await confirmUnsynced(deps, target, synced.reason))) {
      deps.notify.warn(`The sandbox of ${target.ticketLabel} stays. You did not confirm the removal.`);
      return false;
    }
    const removal = box.runner === 'ssh'
      ? await removeSshVerified(runner, ref)
      : await removeRunner(deps, runner, ref, (s) => s.ticketId === target.ticketId && s.core === target.core);
    if (!removal.ok) {
      // Keep the bridge dir and clone record: the Remove affordance retries against them.
      await deps.notify.error(`The sandbox of ${target.ticketLabel} was not removed (${disposeFailures(removal)}). The sandbox and its evidence folder stay. Remove the sandbox again to retry.`);
      return false;
    }
    return true;
  } catch (err) {
    await deps.notify.error(`The sandbox of ${target.ticketLabel} was not removed: ${reasonText(err)}`);
    return false;
  }
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
  else deps.notify.warn(`The sandbox of ${target.ticketLabel} did not sync before it stopped: ${synced.reason}`);
  try {
    await runner.stop();
    return true;
  } catch (err) {
    deps.notify.warn(`The sandbox of ${target.ticketLabel} did not stop: ${reasonText(err)}`);
    return false;
  }
}

/**
 * Ticket done (arch:AC-37): merged → the work is on the remote, so remove the
 * sandbox (guarded, verified, no pre-sync); unmerged → sync + stop only.
 */
export async function onDoneOp(deps: SandboxLifecycleDeps, target: SandboxSyncTarget, merged: boolean): Promise<boolean> {
  if (!merged) return stopSandboxOp(deps, target);
  return removeSandboxGuarded(deps, target, { skipSync: true });
}

/**
 * Backfill: sandboxes of done+merged tickets that survived (stopped at done
 * before this rule, or a failed removal). Removed by name, so a sandbox whose
 * bridge dir / clone record is already gone is still cleaned up.
 */
export async function removeDoneMergedSandboxes(
  deps: SandboxLifecycleDeps,
  doneMerged: ReadonlySet<number>,
  targetOf: (ticketId: number, core: string) => SandboxSyncTarget,
  debug: (m: string) => void = () => {},
): Promise<number> {
  const inv = await inventoryOf(deps);
  let removed = 0;
  for (const box of inv.sandboxes) {
    if (box.invalidCore === true || !doneMerged.has(box.ticketId) || !deps.owns(box.ticketId)) continue;
    const target = targetOf(box.ticketId, box.core);
    if (target.worktree === undefined) debug(`karst: ${target.ticketLabel} has no clone record; removing sandbox ${box.name} by name, skipping the git remote step`);
    if (await removeSandboxGuarded(deps, target, { skipSync: true })) removed += 1;
  }
  return removed;
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
  /** The recorded placement backend; `null`/absent = none recorded, so the core's sandbox kind is the fallback. */
  readonly placementBackend?: BackendKind | null;
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
  const listed = (kind: BackendKind): boolean => !listingFailedFor(inv.errors, kind);
  const running: number[] = [], stopped: number[] = [], missing: number[] = [];
  for (const t of live) {
    if (!owns(t.id)) continue;
    const box = inv.sandboxes.find((s) => s.ticketId === t.id && s.core === t.sessionProvider);
    if (box) (box.state === 'running' ? running : stopped).push(t.id);
    else {
      // Recorded placement decides (arch:AC-32); a core only tells which sandbox kind it would use.
      const kind = t.placementBackend ?? sandboxKindOfCore(t.sessionProvider);
      // No ssh inventory exists yet (T1387, D826): a recorded ssh placement proves nothing missing.
      if (kind !== 'host' && kind !== 'ssh' && t.sessionId !== null && listed(kind)) {
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
  if (o.runner === 'sbx') await deps.releaseGrant?.(o.name);
  const removal = await removeVerified(deps, async () => {
    if (o.runner === 'sbx') return disposeResult([disposeStep('sbx rm', await (deps.proc ?? NODE_SBX_PROCESS).run('sbx', ['rm', '--force', o.name]))]);
    const docker = deps.dockerProc ?? NODE_DOCKER_PROCESS;
    // The agent container is `--rm`: an orphan found by its volumes has no container, so the volumes are what keep it listed.
    const container = await docker.run('docker', ['rm', '--force', o.name]);
    const volumes = await docker.run('docker', ['volume', 'rm', '--force', `${o.name}-repo`, `${o.name}-data`]);
    return disposeResult([disposeStep('docker rm', container), disposeStep('docker volume rm', volumes)]);
  }, (s) => s.name === o.name);
  if (!removal.ok) throw new Error(disposeFailures(removal));
}

/** `karst.sandbox.cleanupOrphans`: remove this project's orphan sandboxes, only on confirmation. */
export async function cleanupOrphansOp(deps: SandboxLifecycleDeps, liveTicketIds: ReadonlySet<number>): Promise<number> {
  const inv = await inventoryOf(deps);
  const orphans = inv.sandboxes.filter((s) => s.invalidCore === true || !liveTicketIds.has(s.ticketId));
  if (orphans.length === 0) {
    deps.notify.info('This project has no orphan sandboxes.');
    return 0;
  }
  const choice = await deps.choose(
    `Remove ${plural(orphans.length, 'orphan sandbox', 'orphan sandboxes')} of this project? ${orphans.map((o) => o.name).join(', ')}`,
    [REMOVE_ORPHANS, CANCEL],
  );
  if (choice !== REMOVE_ORPHANS) return 0;
  let removed = 0;
  for (const o of orphans) {
    try {
      if (o.invalidCore) await removeInvalidCoreSandbox(deps, o);
      else {
        // A listed orphan is removed by its own runner, never by the placement's (D826).
        // Stryker disable next-line StringLiteral: equivalent, a removal reads no branch
        const removal = await removeRunner(deps, sandboxRunnerFor(listedBoxDeps(deps), o.core, o.ticketId)!, { hostWorktreePath: deps.worktreeOf?.(o.ticketId) ?? '', branch: '' }, (s) => s.name === o.name);
        if (!removal.ok) throw new Error(disposeFailures(removal));
        if (!deps.worktreeOf?.(o.ticketId)) deps.debug?.(`sandbox orphan ${o.name}: no recorded worktree, skipped the host remote step`);
      }
      await deps.bridges?.dispose(o.ticketId);
      removed += 1;
    } catch (err) {
      deps.notify.warn(`The orphan sandbox ${o.name} was not removed: ${reasonText(err)}`);
    }
  }
  deps.notify.info(`Removed ${plural(removed, 'orphan sandbox', 'orphan sandboxes')}.`);
  return removed;
}
