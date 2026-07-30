import { randomBytes } from 'node:crypto';
import { defaultGitRunner } from '../../integrations/git.js';
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
}

export interface CommitView {
  hash: string;
  shortHash: string;
  subject: string;
  author: string;
  authoredAt: string;
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
}

export interface TicketChangesState {
  ticketId: number;
  worktreeCount: number;
  commitCount: number;
  pendingCount: number;
  worktrees: WorktreeChangesView[];
}

export interface TicketChangesSnapshot {
  state: TicketChangesState;
  targets: ReadonlyMap<string, DiffTarget>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function defaultInspect(spec: WorktreeSpec): Promise<InspectedWorktree> {
  return inspectWorktree(defaultGitRunner, spec);
}

export async function buildTicketChangesSnapshot(
  ticketId: number,
  worktrees: readonly WorktreeSpec[],
  inspect: (spec: WorktreeSpec) => Promise<InspectedWorktree> = defaultInspect,
  makePrefix: () => string = () => randomBytes(16).toString('hex'),
): Promise<TicketChangesSnapshot> {
  const settled = await Promise.all(
    worktrees.map(async (spec) => {
      try {
        return { spec, inspected: await inspect(spec), error: null };
      } catch (error) {
        return { spec, inspected: null, error: errorMessage(error) };
      }
    }),
  );
  const targets = new Map<string, DiffTarget>();
  const prefix = makePrefix();
  let counter = 0;

  const changedFile = (file: InspectedFile): ChangedFileView => {
    const changeId = `${prefix}:${++counter}`;
    targets.set(changeId, file.target);
    return { changeId, status: file.status, path: file.path, oldPath: file.oldPath };
  };

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
      };
    }

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
        files: commit.files.map(changedFile),
      })),
      staged: inspected.staged.map(changedFile),
      unstaged: inspected.unstaged.map(changedFile),
      untracked: inspected.untracked.map(changedFile),
      error: null,
    };
  });

  const commitCount = views.reduce((count, worktree) => count + worktree.commits.length, 0);
  const pendingCount = views.reduce(
    (count, worktree) => count + worktree.staged.length + worktree.unstaged.length + worktree.untracked.length,
    0,
  );

  return {
    state: { ticketId, worktreeCount: worktrees.length, commitCount, pendingCount, worktrees: views },
    targets,
  };
}
