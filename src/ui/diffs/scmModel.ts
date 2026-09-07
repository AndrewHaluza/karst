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

export type ScmCategory = 'staged' | 'unstaged' | 'untracked' | 'commits' | 'error';

const CATEGORY_ORDER: readonly ScmCategory[] = ['staged', 'unstaged', 'untracked', 'commits', 'error'];

function toResources(
  files: readonly { changeId: string; path: string; status: FileChangeStatus; oldPath: string | null }[],
  repoPath: string,
): ScmResourceModel[] {
  return files.map((file) => ({
    changeId: file.changeId,
    path: file.path,
    absolutePath: join(repoPath, file.path),
    status: file.status,
    oldPath: file.oldPath,
  }));
}

export function buildScmGroups(
  snapshot: TicketChangesSnapshot,
  worktrees: readonly WorktreeSpec[],
): ScmGroupModel[] {
  const categories = new Map<ScmCategory, ScmGroupModel[]>();
  for (const cat of CATEGORY_ORDER) {
    if (cat !== 'error') categories.set(cat, []);
  }
  const errorGroups: ScmGroupModel[] = [];

  for (let i = 0; i < snapshot.state.worktrees.length; i++) {
    const view = snapshot.state.worktrees[i];
    const spec = worktrees[i];
    if (!view || !spec) continue;

    if (view.error) {
      errorGroups.push({
        id: `error-${view.label}`,
        label: `Error — ${view.label}: ${view.error}`,
        resources: [],
      });
      continue;
    }

    if (view.staged.length > 0) {
      categories.get('staged')!.push({
        id: `staged-${view.label}`,
        label: `Staged — ${view.label}`,
        resources: toResources(view.staged, spec.path),
      });
    }

    if (view.unstaged.length > 0) {
      categories.get('unstaged')!.push({
        id: `unstaged-${view.label}`,
        label: `Unstaged — ${view.label}`,
        resources: toResources(view.unstaged, spec.path),
      });
    }

    if (view.untracked.length > 0) {
      categories.get('untracked')!.push({
        id: `untracked-${view.label}`,
        label: `Untracked — ${view.label}`,
        resources: toResources(view.untracked, spec.path),
      });
    }

    for (const commit of view.commits) {
      if (commit.files.length === 0) continue;
      categories.get('commits')!.push({
        id: `commits-${view.label}`,
        label: `Commits — ${view.label}`,
        resources: toResources(commit.files, spec.path),
      });
    }
  }

  const groups: ScmGroupModel[] = [];
  for (const cat of CATEGORY_ORDER) {
    if (cat === 'error') {
      groups.push(...errorGroups);
    } else {
      groups.push(...categories.get(cat)!);
    }
  }

  return groups;
}