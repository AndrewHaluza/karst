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
  /** The worktree's display label, e.g. `backend`. */
  repoLabel: string;
  /** Absolute path of the worktree the file lives in. */
  repoPath: string;
  /** Which category group this row was placed in. */
  category: ScmCategory;
  /** `karst-change:/<repoLabel>/<path>` — the row's synthetic URI. */
  uri: string;
}

/** One collapsible group in the Source Control view. */
export interface ScmGroupModel {
  /** Stable id, unique within one render. */
  id: string;
  label: string;
  resources: ScmResourceModel[];
}

export type ScmCategory = 'staged' | 'unstaged' | 'untracked' | 'commits' | 'error';

/**
 * The row's synthetic URI. VS Code derives an SCM row's label and description
 * from `resourceUri` and offers no override, so the repository is encoded in
 * the path to keep it legible in a flat, repo-spanning group.
 */
export function changeUri(repoLabel: string, path: string): string {
  const segments = [repoLabel, ...path.split('/')].filter((segment) => segment.length > 0);
  return `karst-change:/${segments.map(encodeURIComponent).join('/')}`;
}

function toResources(
  files: readonly { changeId: string; path: string; status: FileChangeStatus; oldPath: string | null }[],
  repoPath: string,
  repoLabel: string,
  category: ScmCategory,
): ScmResourceModel[] {
  return files.map((file) => ({
    changeId: file.changeId,
    path: file.path,
    absolutePath: join(repoPath, file.path),
    status: file.status,
    oldPath: file.oldPath,
    repoLabel,
    repoPath,
    category,
    uri: changeUri(repoLabel, file.path),
  }));
}

export function buildScmGroups(
  snapshot: TicketChangesSnapshot,
  worktrees: readonly WorktreeSpec[],
): ScmGroupModel[] {
  const stagedRows: ScmResourceModel[] = [];
  const unstagedRows: ScmResourceModel[] = [];
  const untrackedRows: ScmResourceModel[] = [];
  const commitGroups: ScmGroupModel[] = [];
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

    stagedRows.push(...toResources(view.staged, spec.path, view.label, 'staged'));
    unstagedRows.push(...toResources(view.unstaged, spec.path, view.label, 'unstaged'));
    untrackedRows.push(...toResources(view.untracked, spec.path, view.label, 'untracked'));

    for (const commit of view.commits) {
      if (commit.files.length === 0) continue;
      commitGroups.push({
        id: `commit-${view.label}-${commit.shortHash}`,
        label: `${commit.shortHash} — ${commit.subject} (${view.label})`,
        resources: toResources(commit.files, spec.path, view.label, 'commits'),
      });
    }
  }

  const byRepoThenPath = (a: ScmResourceModel, b: ScmResourceModel): number =>
    a.repoLabel.localeCompare(b.repoLabel) || a.path.localeCompare(b.path);
  stagedRows.sort(byRepoThenPath);
  unstagedRows.sort(byRepoThenPath);
  untrackedRows.sort(byRepoThenPath);

  const groups: ScmGroupModel[] = [];
  if (stagedRows.length > 0) groups.push({ id: 'staged', label: 'Staged Changes', resources: stagedRows });
  if (unstagedRows.length > 0) groups.push({ id: 'unstaged', label: 'Changes', resources: unstagedRows });
  if (untrackedRows.length > 0) groups.push({ id: 'untracked', label: 'Untracked', resources: untrackedRows });
  groups.push(...commitGroups);
  groups.push(...errorGroups);
  return groups;
}
