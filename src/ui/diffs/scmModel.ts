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
  /** `karst-change:/<label segments>/<name>~<hash>/<path>` — the row's synthetic URI. */
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
 * A short, stable discriminator for a worktree directory. Not a security
 * hash — it exists only so two worktrees cannot mint the same row URI.
 */
function repoKey(repoPath: string): string {
  return createHash('sha1').update(repoPath).digest('hex').slice(0, 8);
}

/**
 * Split a path-shaped string into URI-safe segments.
 *
 * Drops empties and dot-segments. `repoDisplayPath` renders a repository
 * OUTSIDE the project root as `../<name>` and one under it as `./<sub>`
 * (`src/ui/worktreePath.ts:29-30`), so a label is never a bare name — and a
 * `.` or `..` segment in a `resourceUri` is a path traversal VS Code will not
 * render as an ordinary Source Control row.
 */
function uriSegments(value: string): string[] {
  return value
    .split('/')
    .filter((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

/**
 * The row's synthetic URI. VS Code derives an SCM row's label and description
 * from `resourceUri` and offers no override, so the repository is encoded in
 * the path to keep it legible in a flat, repo-spanning group.
 *
 * The URI shape is `karst-change:/<label segments>/<name>~<hash>/<path>`. The
 * label's segments are what a reader sees, with the short hash of the
 * worktree's own `repoPath` — unique by definition — attached to the LAST
 * segment, the repository's own name. Two worktrees can share a label (two
 * checkouts of one repo whose directory names also match), so that hash keeps
 * them apart.
 */
export function changeUri(repoLabel: string, repoPath: string, path: string): string {
  const labelParts = uriSegments(repoLabel);
  // The hash rides the LAST label segment — the repository's own name, which
  // is what identifies the row — so uniqueness survives dropping `..`.
  const name = labelParts.pop() ?? 'repo';
  const segments = [
    ...labelParts,
    `${name}~${repoKey(repoPath)}`,
    ...uriSegments(path),
  ];
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
    uri: changeUri(repoLabel, repoPath, file.path),
  }));
}

/**
 * Make every spec's label unique within one ticket.
 *
 * A ticket can hold two worktrees for the SAME repository (two checkouts, or
 * a stale row beside a live one). `repoDisplayPath` is a pure function of
 * `repo`, so both render identically — and `changeUri` keys a row's identity
 * on that label, so two files at the same repo-relative path would mint the
 * same URI. `path` is unique per worktree, so its basename always separates
 * them.
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
      ? { ...spec, label: `${spec.label}~${repoKey(spec.path)}` }
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
