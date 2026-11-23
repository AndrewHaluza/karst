import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { defaultGitRunner } from '../../integrations/git.js';
import { formatId } from '../../model/entityId.js';
import { plural } from '../../model/notifyText.js';
import {
  inspectWorktree,
  type DiffTarget,
  type FileChangeStatus,
  type InspectedFile,
  type InspectedWorktree,
  type WorktreeSpec,
} from './git.js';

export interface ChangedFileView {
  changeId: string;
  status: FileChangeStatus;
  path: string;
  oldPath: string | null;
  absolutePath: string;
}

export interface CommitView {
  hash: string;
  shortHash: string;
  subject: string;
  author: string;
  /** The raw ISO instant, kept for `<time datetime>` and the row's `title`. */
  authoredAt: string;
  /** `authoredAt` formatted for people (DF-16). */
  authoredLabel: string;
  files: ChangedFileView[];
}

export interface WorktreeChangesView {
  label: string;
  branch: string | null;
  baseRef: string | null;
  commits: CommitView[];
  staged: ChangedFileView[];
  unstaged: ChangedFileView[];
  untracked: ChangedFileView[];
  error: string | null;
  /** The row's count text, built host-side by `worktreeCountText` (@arch:NTF-07). */
  countText: string;
}

export interface TicketChangesState {
  ticketId: number;
  /**
   * The ticket's own name — the editor tab title without the ` — Changes`
   * suffix (DF-17). The webview header shows it above the summary.
   */
  ticketLabel: string;
  worktreeCount: number;
  commitCount: number;
  pendingCount: number;
  worktrees: WorktreeChangesView[];
  /** The header summary, built host-side by `diffsSummaryText` (@arch:NTF-07). */
  summaryText: string;
}

/** Which part of the tree a changed file came from (DF-3). */
export type SnapshotFileGroup = 'commit' | 'staged' | 'unstaged' | 'untracked';

/**
 * The host-only facts of one changed row, keyed by its opaque `changeId`.
 *
 * The webview names a `changeId` and nothing else, so the row action needs a
 * path, a status and the worktree it belongs to — all of which the host
 * resolved itself. Keeping them here (per snapshot, therefore per panel)
 * replaces the window-wide `lastLoadedSnapshot` that made Discard in one panel
 * act on another panel's data (DF-3).
 */
export interface SnapshotFileEntry {
  /** Absolute path of the worktree the file lives in. */
  repoPath: string;
  /** Repo-relative path, as git reported it. */
  path: string;
  status: FileChangeStatus;
  group: SnapshotFileGroup;
}

/** `1 commit · clean`, `2 commits · 1 pending` — one text for a worktree row. */
export function worktreeCountText(commitCount: number, pendingCount: number): string {
  return `${plural(commitCount, 'commit', 'commits')} · ${pendingCount ? `${pendingCount} pending` : 'clean'}`;
}

/** `1 worktree · 1 commit · 0 pending` — one text for the changes header. */
export function diffsSummaryText(worktreeCount: number, commitCount: number, pendingCount: number): string {
  return `${plural(worktreeCount, 'worktree', 'worktrees')} · ${plural(commitCount, 'commit', 'commits')} · ${pendingCount} pending`;
}

const AUTHORED_FORMAT = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
});

/**
 * A commit's time, for people (DF-16). `git log` reports an ISO string, which
 * the commit meta line used to show verbatim; this renders it in the reader's
 * own locale and zone. `format` is injectable so a test can pin the output.
 * An unparseable value is handed back unchanged rather than shown as
 * "Invalid Date".
 */
export function authoredLabel(iso: string, format: Intl.DateTimeFormat = AUTHORED_FORMAT): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return format.format(date);
}

export interface TicketChangesSnapshot {
  state: TicketChangesState;
  targets: ReadonlyMap<string, DiffTarget>;
  /**
   * Host-only: what a row action needs, per `changeId` (DF-3). It is never
   * posted to a webview — `state` is the only part that crosses the boundary.
   */
  files: ReadonlyMap<string, SnapshotFileEntry>;
}

/**
 * Resolve an opaque `changeId` to the file view the host itself built for it,
 * or `null` when the id is stale or forged. This is the ONLY path from a
 * webview's `open-file` request to an on-disk file: the webview never supplies
 * a path, so a crafted message cannot aim `Uri.file` anywhere the snapshot did
 * not already name.
 */
export function findChangedFile(
  snapshot: TicketChangesSnapshot,
  changeId: string,
): ChangedFileView | null {
  for (const worktree of snapshot.state.worktrees) {
    for (const files of [
      worktree.staged,
      worktree.unstaged,
      worktree.untracked,
      ...worktree.commits.map((commit) => commit.files),
    ]) {
      for (const file of files) {
        if (file.changeId === changeId) return file;
      }
    }
  }
  return null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function abortError(): Error {
  const error = new Error('Ticket changes refresh was aborted');
  error.name = 'AbortError';
  return error;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

function defaultInspect(
  spec: WorktreeSpec,
  signal?: AbortSignal,
): Promise<InspectedWorktree> {
  return inspectWorktree(defaultGitRunner, spec, signal);
}

export async function buildTicketChangesSnapshot(
  ticketId: number,
  worktrees: readonly WorktreeSpec[],
  inspect: (
    spec: WorktreeSpec,
    signal?: AbortSignal,
  ) => Promise<InspectedWorktree> = defaultInspect,
  makePrefix: () => string = () => randomBytes(16).toString('hex'),
  signal?: AbortSignal,
  ticketLabel: string = formatId('ticket', ticketId),
): Promise<TicketChangesSnapshot> {
  throwIfAborted(signal);
  const settled = await Promise.all(
    worktrees.map(async (spec) => {
      try {
        throwIfAborted(signal);
        const inspected = await inspect(spec, signal);
        throwIfAborted(signal);
        return { spec, inspected, error: null };
      } catch (error) {
        if (signal?.aborted || (error instanceof Error && error.name === 'AbortError')) {
          throw abortError();
        }
        return { spec, inspected: null, error: errorMessage(error) };
      }
    }),
  );
  throwIfAborted(signal);
  const targets = new Map<string, DiffTarget>();
  const files = new Map<string, SnapshotFileEntry>();
  const prefix = makePrefix();
  let counter = 0;

  const views = settled.map(({ spec, inspected, error }): WorktreeChangesView => {
    if (!inspected) {
      return {
        label: spec.label,
        branch: spec.branch,
        baseRef: spec.baseRef,
        commits: [],
        staged: [],
        unstaged: [],
        untracked: [],
        error,
        countText: worktreeCountText(0, 0),
      };
    }

    const changedFile = (
      file: InspectedFile,
      group: SnapshotFileGroup,
    ): ChangedFileView => {
      const changeId = `${prefix}:${++counter}`;
      targets.set(changeId, file.target);
      files.set(changeId, { repoPath: spec.path, path: file.path, status: file.status, group });
      return {
        changeId,
        status: file.status,
        path: file.path,
        oldPath: file.oldPath,
        absolutePath: join(spec.path, file.path),
      };
    };

    const pending = inspected.staged.length + inspected.unstaged.length + inspected.untracked.length;
    return {
      label: spec.label,
      branch: spec.branch,
      baseRef: spec.baseRef,
      commits: inspected.commits.map((commit) => ({
        hash: commit.hash,
        shortHash: commit.shortHash,
        subject: commit.subject,
        author: commit.author,
        authoredAt: commit.authoredAt,
        authoredLabel: authoredLabel(commit.authoredAt),
        files: commit.files.map((file) => changedFile(file, 'commit')),
      })),
      staged: inspected.staged.map((file) => changedFile(file, 'staged')),
      unstaged: inspected.unstaged.map((file) => changedFile(file, 'unstaged')),
      untracked: inspected.untracked.map((file) => changedFile(file, 'untracked')),
      error: null,
      countText: worktreeCountText(inspected.commits.length, pending),
    };
  });

  const commitCount = views.reduce((count, worktree) => count + worktree.commits.length, 0);
  const pendingCount = views.reduce(
    (count, worktree) => count + worktree.staged.length + worktree.unstaged.length + worktree.untracked.length,
    0,
  );

  return {
    state: {
      ticketId,
      ticketLabel,
      worktreeCount: worktrees.length,
      commitCount,
      pendingCount,
      worktrees: views,
      summaryText: diffsSummaryText(worktrees.length, commitCount, pendingCount),
    },
    targets,
    files,
  };
}
