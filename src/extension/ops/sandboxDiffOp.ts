import { sandboxRunnerFor, type SandboxSyncDeps, type SandboxSyncTarget } from './sandboxSyncOps.js';

export interface SandboxDiffDeps extends SandboxSyncDeps {
  /** Opens the diff text in a read-only editor (the VS Code binding). */
  readonly showDiff: (title: string, diff: string) => Promise<void>;
}

/**
 * Show what a sandbox sync would bring in: `git diff <host branch>...<sandbox
 * branch>` after fetching, in a read-only editor. Changes nothing on the host
 * branch, so the user can look before deciding to sync or remove.
 */
export async function diffSandboxOp(deps: SandboxDiffDeps, target: SandboxSyncTarget): Promise<boolean> {
  if (!target.worktree?.branch) {
    await deps.notify.error(`Karst: ${target.ticketLabel} has no worktree branch to diff against.`);
    return false;
  }
  const runner = sandboxRunnerFor(deps, target.core, target.ticketId);
  if (!runner?.diff) {
    await deps.notify.error(`Karst: ${target.ticketLabel} has no sandbox (core ${target.core ?? 'unknown'}).`);
    return false;
  }
  const result = await runner.diff({ hostWorktreePath: target.worktree.path, branch: target.worktree.branch });
  if (!result.ok) {
    await deps.notify.error(`Karst: sandbox diff for ${target.ticketLabel} failed: ${result.reason}`);
    return false;
  }
  if (result.diff.trim() === '') {
    deps.notify.info(`Karst: the sandbox of ${target.ticketLabel} has no commits beyond the host branch.`);
    return true;
  }
  await deps.showDiff(`${target.ticketLabel} sandbox diff (${result.ref})`, result.diff);
  return true;
}
