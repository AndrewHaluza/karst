import { join } from 'node:path';
import type { FileChangeStatus, WorktreeSpec } from './git.js';
import type { TicketChangesSnapshot } from './snapshot.js';

/** One file row inside an SCM group. */
export interface ScmResourceModel {
  /** Opaque token resolved back to a DiffTarget by the controller. */
  changeId: string;
  /** Repo-relative path, as git reported it. */
  path: string;
  /** Absolute path on disk, for the host's label/icon rendering only. */
  absolutePath: string;
  status: FileChangeStatus;
  /** Rename source, or null. */
  oldPath: string | null;
}

/** One collapsible group in the Source Control view. */
export interface ScmGroupModel {
  /** Stable id, unique within one render. */
  id: string;
  label: string;
  resources: ScmResourceModel[];
}

export function buildScmGroups(
  snapshot: TicketChangesSnapshot,
  worktrees: readonly WorktreeSpec[],
): ScmGroupModel[] {
  const groups: ScmGroupModel[] = [];

  for (let i = 0; i < snapshot.state.worktrees.length; i++) {
    const view = snapshot.state.worktrees[i];
    const spec = worktrees[i];
    if (!view || !spec) continue;
    if (view.error) continue;

    if (view.staged.length > 0) {
      groups.push({
        id: `w${i}-staged`,
        label: `${view.label} — Staged`,
        resources: view.staged.map((file) => ({
          changeId: file.changeId,
          path: file.path,
          absolutePath: join(spec.path, file.path),
          status: file.status,
          oldPath: file.oldPath,
        })),
      });
    }

    if (view.unstaged.length > 0) {
      groups.push({
        id: `w${i}-unstaged`,
        label: `${view.label} — Unstaged`,
        resources: view.unstaged.map((file) => ({
          changeId: file.changeId,
          path: file.path,
          absolutePath: join(spec.path, file.path),
          status: file.status,
          oldPath: file.oldPath,
        })),
      });
    }

    if (view.untracked.length > 0) {
      groups.push({
        id: `w${i}-untracked`,
        label: `${view.label} — Untracked`,
        resources: view.untracked.map((file) => ({
          changeId: file.changeId,
          path: file.path,
          absolutePath: join(spec.path, file.path),
          status: file.status,
          oldPath: file.oldPath,
        })),
      });
    }

    for (let j = 0; j < view.commits.length; j++) {
      const commit = view.commits[j];
      if (!commit) continue;
      if (commit.files.length === 0) continue;
      groups.push({
        id: `w${i}-c${j}`,
        label: `${view.label} — ${commit.shortHash} ${commit.subject}`,
        resources: commit.files.map((file) => ({
          changeId: file.changeId,
          path: file.path,
          absolutePath: join(spec.path, file.path),
          status: file.status,
          oldPath: file.oldPath,
        })),
      });
    }
  }

  return groups;
}