import type { SessionRunner } from '../../agent/sessionRunner.js';
import { backendKindOf, removeSandboxGuarded, type SandboxLifecycleDeps } from './sandboxLifecycleOps.js';
import { recordSyncedHead, sandboxRunnerFor, type SandboxSyncTarget } from './sandboxSyncOps.js';

/** The sandbox primitives "Rebase on base" needs (arch:AC-33 no-sync recreate). */
export interface SandboxRebaseDeps extends SandboxLifecycleDeps {
  readonly reopen: (ticketId: number) => Promise<void>;
  /** Test seams. */
  readonly runner?: SessionRunner;
  readonly remove?: typeof removeSandboxGuarded;
}

/**
 * True when the sandbox holds commits the host branch lacks. A host ticket has
 * none. A sandbox that cannot be read counts as unsynced: the rebase must never
 * run on a guess, because the recreate that follows would drop those commits.
 */
export async function sandboxHasUnsynced(deps: SandboxRebaseDeps, target: SandboxSyncTarget): Promise<boolean> {
  if (backendKindOf(target.core) === 'host') return false;
  const branch = target.worktree?.branch;
  if (!target.worktree || !branch) return true;
  const runner = deps.runner ?? sandboxRunnerFor(deps, target.core, target.ticketId);
  if (!runner?.diff) return true;
  const result = await runner.diff({ hostWorktreePath: target.worktree.path, branch });
  return !result.ok || result.diff.trim() !== '';
}

/** Remove WITHOUT the pre-remove sync, record the new head, reopen. Throws when the clone could not be recreated. */
export async function recreateSandboxNoSync(deps: SandboxRebaseDeps, target: SandboxSyncTarget): Promise<void> {
  if (backendKindOf(target.core) === 'host') return;
  const removed = await (deps.remove ?? removeSandboxGuarded)(deps, target, { skipSync: true });
  if (!removed) throw new Error('the sandbox could not be removed');
  await recordSyncedHead(deps, target);
  await deps.reopen(target.ticketId);
}
