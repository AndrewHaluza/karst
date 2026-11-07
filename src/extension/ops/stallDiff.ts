import type { GitRunner } from '../../integrations/git.js';
import { resolveMergeBase } from '../../ui/dashboard/worktreeStats.js';
import type { WorktreeView } from '../../store/dashboard.js';

/** The ticket's diff against its base: file names and the stat text. */
export interface TicketDiff {
  files: string[];
  stat: string;
}

/** The stat text is part of an agent prompt and a banner line: keep it small. */
export const STALL_STAT_MAX_CHARS = 4_000;

type Tree = Pick<WorktreeView, 'repo' | 'path' | 'baseRef'>;

async function ok(git: GitRunner, args: string[], cwd: string): Promise<string | null> {
  const r = await git(args, cwd);
  return r.exitCode === 0 && r.stdoutTruncated !== true ? r.stdout : null;
}

/**
 * The diff of every worktree of a ticket against its merge base, or null when
 * any worktree cannot be read. A null answer is "unknown": the docs-only rule
 * then fails closed, so no accept option is offered on a guess.
 */
export async function readTicketDiff(git: GitRunner, trees: readonly Tree[]): Promise<TicketDiff | null> {
  if (trees.length === 0) return null;
  const files: string[] = [];
  const stats: string[] = [];
  for (const tree of trees) {
    if (!tree.baseRef) return null;
    let base: string;
    try {
      base = await resolveMergeBase(git, tree as WorktreeView, tree.baseRef);
    } catch {
      return null;
    }
    const names = await ok(git, ['diff', '--name-only', '--no-ext-diff', base, '--'], tree.path);
    const stat = await ok(git, ['diff', '--stat', '--no-ext-diff', base, '--'], tree.path);
    // An untracked file is not in `git diff`, yet it ships: the docs-only rule must see it.
    const untracked = await ok(git, ['ls-files', '--others', '--exclude-standard'], tree.path);
    if (names === null || stat === null || untracked === null) return null;
    files.push(...`${names}\n${untracked}`.split('\n').map((l) => l.trim()).filter((l) => l !== ''));
    if (stat.trim() !== '') stats.push(stat.trimEnd());
  }
  const text = stats.join('\n');
  return { files, stat: text.length > STALL_STAT_MAX_CHARS ? `${text.slice(0, STALL_STAT_MAX_CHARS)}\n…` : text };
}
