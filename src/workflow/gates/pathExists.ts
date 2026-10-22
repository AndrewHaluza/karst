import { existsSync } from 'node:fs';

/** Whether a worktree path exists — a stat, not a spawn. Own module so tests with fake paths can stub it. */
export function worktreePathExists(path: string): boolean {
  return existsSync(path);
}
