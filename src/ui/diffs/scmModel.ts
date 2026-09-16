import { createHash } from 'node:crypto';
import { basename, join } from 'node:path';
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
}

/** One collapsible group in the Source Control view. */
export interface ScmGroupModel {
  /** Stable id, unique within one render. */
  id: string;
  label: string;
  resources: ScmResourceModel[];
}

export type ScmCategory = 'staged' | 'unstaged' | 'untracked' | 'commits' | 'error';

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
  }));
}

/**
 * Make every spec's label unique within one ticket.
 *
 * A ticket can hold two worktrees for the SAME repository (two checkouts, or
 * a stale row beside a live one). `repoDisplayPath` is a pure function of
 * `repo`, so both render identically — and a row's identity is keyed on that
 * label, so two files at the same repo-relative path would be
 * indistinguishable. `path` is unique per worktree, so its basename always
 * separates them.
 *
 * Two worktrees can agree on BOTH the repository label and the directory
 * basename (two checkouts named `be` under different parents). The basename
 * suffix then collides too, so a second pass falls back to a short stable
 * hash of the worktree path — which is unique by definition — keeping the
 * labels, and the group ids derived from them, collision-free.
 *
 * Only colliding labels are rewritten; a ticket whose labels are already
 * distinct is returned with every label untouched.
 */
export function disambiguateLabels(
  specs: readonly WorktreeSpec[],
): WorktreeSpec[] {
  const countsByLabel = (items: readonly WorktreeSpec[]): Map<string, number> => {
    const counts = new Map<string, number>();
    for (const spec of items) counts.set(spec.label, (counts.get(spec.label) ?? 0) + 1);
    return counts;
  };

  const originalCounts = countsByLabel(specs);
  const withBasename = specs.map((spec) =>
    (originalCounts.get(spec.label) ?? 0) > 1
      ? { ...spec, label: `${spec.label} (${basename(spec.path)})` }
      : spec,
  );

  const basenameCounts = countsByLabel(withBasename);
  return withBasename.map((spec) =>
    (basenameCounts.get(spec.label) ?? 0) > 1
      ? { ...spec, label: `${spec.label}~${createHash('sha1').update(spec.path).digest('hex').slice(0, 8)}` }
      : spec,
  );
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
