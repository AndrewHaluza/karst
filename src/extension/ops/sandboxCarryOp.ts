import { tmpdir } from 'node:os';
import { sandboxHeadRef } from '../../agent/cloneSyncClass.js';
import { hostHeadFileFor, readHostHead } from '../../agent/hostHead.js';
import { NODE_SBX_PROCESS } from '../../agent/sbx/sbxProcess.js';
import type { SessionRunner } from '../../agent/sessionRunner.js';
import { carryCommits } from './sandboxCarry.js';
import { removeSandboxGuarded, type SandboxLifecycleDeps } from './sandboxLifecycleOps.js';
import { classifyDivergence, nodeGit } from './sandboxRewrite.js';
import { recordSyncedHead, sandboxRunnerFor, type SandboxSyncTarget } from './sandboxSyncOps.js';

export interface SandboxCarryDeps extends SandboxLifecycleDeps {
  /** Reopen the ticket's sandbox session after the clone was recreated. */
  readonly reopen: (ticketId: number) => Promise<void>;
  /** Test seams. */
  readonly runner?: SessionRunner;
  readonly remove?: typeof removeSandboxGuarded;
  readonly scratch?: string;
}

/**
 * "Carry sandbox commits onto host branch" (arch:AC-33): the host rewrote the
 * ticket branch (rebase/amend) under a sandbox that holds agent commits. Replay
 * the commits after the old host head with `git am -3`, then recreate the clone
 * WITHOUT the pre-remove sync (it would fail as diverged; the commits are on the
 * host now) and reopen. A conflict leaves the am state to the user: never forced.
 */
export async function carrySandboxOp(deps: SandboxCarryDeps, target: SandboxSyncTarget): Promise<boolean> {
  const label = target.ticketLabel;
  const fail = async (why: string): Promise<false> => {
    await deps.notify.error(`Karst: cannot carry the sandbox commits of ${label}: ${why}`);
    return false;
  };
  if (!target.worktree?.branch) return fail('no worktree branch.');
  if (!deps.owns(target.ticketId)) return fail('the sandbox belongs to another window.');
  const runner = deps.runner ?? sandboxRunnerFor(deps, target.core, target.ticketId);
  if (!runner?.fetchClone) return fail(`no sandbox (core ${target.core ?? 'unknown'}).`);
  const ref = { hostWorktreePath: target.worktree.path, branch: target.worktree.branch };
  const fetched = await runner.fetchClone(ref);
  if (!fetched.ok) return fail(fetched.reason);
  const run = nodeGit(deps.proc ?? NODE_SBX_PROCESS);
  const dir = deps.evidenceDirOf?.(target.ticketId);
  const recorded = dir ? await readHostHead(hostHeadFileFor(dir), ref.hostWorktreePath) : undefined;
  const verdict = await classifyDivergence(run, { worktree: ref.hostWorktreePath, branch: ref.branch, recorded });
  if (verdict.kind !== 'rewritten') return fail('the host branch was not rewritten (true divergence stays refused, never forced).');
  const carried = await carryCommits(run, { worktree: ref.hostWorktreePath, recorded: verdict.recorded, cloneHead: verdict.cloneHead, scratch: deps.scratch ?? tmpdir() });
  if (!carried.ok) {
    if (carried.reason === 'conflict') {
      return fail(`git am stopped on conflicts in ${carried.paths.join(', ')}. Resolve them in the host worktree (git am --continue); nothing was dropped.`);
    }
    return fail(carried.message);
  }
  // The agent may have committed since the first fetch: removing now would drop those commits.
  const again = await runner.fetchClone(ref);
  const head = again.ok ? await run(ref.hostWorktreePath, ['rev-parse', '--verify', '--quiet', `${sandboxHeadRef(ref.branch)}^{commit}`]) : undefined;
  if (!head || head.code !== 0 || head.stdout.trim() !== verdict.cloneHead) {
    return fail(`${carried.carried} commit(s) were carried, but the sandbox has newer commits (or could not be re-read), so it was kept and not recreated. Apply the newer commits by hand; do not carry again.`);
  }
  const removed = await (deps.remove ?? removeSandboxGuarded)(deps, target, { skipSync: true });
  if (!removed) return false;
  await recordSyncedHead(deps, target);
  await deps.reopen(target.ticketId);
  deps.notify.info(`Karst: carried ${carried.carried} sandbox commit(s) of ${label} onto the host branch; the sandbox was recreated.`);
  return true;
}
