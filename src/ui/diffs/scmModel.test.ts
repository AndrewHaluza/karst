import { describe, it, expect } from 'vitest';
import type { FileChangeStatus } from './git.js';
import type { TicketChangesSnapshot, WorktreeChangesView } from './snapshot.js';
import { buildScmGroups, type ScmGroupModel } from './scmModel.js';

function makeWorktreeChangesView(overrides: Partial<WorktreeChangesView> = {}): WorktreeChangesView {
  return {
    label: 'repo',
    branch: 'main',
    baseRef: 'develop',
    commits: [],
    staged: [],
    unstaged: [],
    untracked: [],
    error: null,
    ...overrides,
  };
}

function makeChangedFileView(overrides: { changeId: string; status: FileChangeStatus; path: string; oldPath?: string | null } = { changeId: 'a', status: 'added', path: 'file.ts' }) {
  return {
    changeId: overrides.changeId,
    status: overrides.status,
    path: overrides.path,
    oldPath: overrides.oldPath ?? null,
    absolutePath: `/wt/repo/${overrides.path}`,
  };
}

function makeSnapshot(views: WorktreeChangesView[]): TicketChangesSnapshot {
  return {
    state: {
      ticketId: 1,
      worktreeCount: views.length,
      commitCount: views.reduce((c, v) => c + v.commits.length, 0),
      pendingCount: views.reduce((c, v) => c + v.staged.length + v.unstaged.length + v.untracked.length, 0),
      worktrees: views,
    },
    targets: new Map(),
  };
}

function makeSpec(path: string): { label: string; path: string; branch: string | null; baseRef: string | null } {
  return { label: 'repo', path, branch: 'main', baseRef: 'develop' };
}

describe('buildScmGroups', () => {
  it('emits category-first groups with repos nested under each category', () => {
    const views = [
      makeWorktreeChangesView({
        label: 'backend',
        staged: [makeChangedFileView({ changeId: '1', status: 'added', path: 'src/a.ts' })],
        unstaged: [],
        untracked: [makeChangedFileView({ changeId: '2', status: 'added', path: 'src/b.ts' })],
        commits: [
          {
            hash: 'abc123',
            shortHash: 'abc123',
            subject: 'feat: add feature',
            author: 'author',
            authoredAt: '2024-01-01T00:00:00Z',
            files: [makeChangedFileView({ changeId: '3', status: 'modified', path: 'src/c.ts' })],
          },
        ],
      }),
      makeWorktreeChangesView({
        label: 'frontend',
        staged: [],
        unstaged: [makeChangedFileView({ changeId: '4', status: 'modified', path: 'src/d.ts' })],
        untracked: [],
        commits: [],
      }),
    ];
    const specs = [makeSpec('/wt/backend'), makeSpec('/wt/frontend')];
    const groups = buildScmGroups(makeSnapshot(views), specs);

    expect(groups.map((g) => g.id)).toEqual([
      'staged-backend',
      'unstaged-frontend',
      'untracked-backend',
      'commits-backend',
    ]);
    expect(groups.map((g) => g.label)).toEqual([
      'Staged — backend',
      'Unstaged — frontend',
      'Untracked — backend',
      'Commits — backend',
    ]);
  });

  it('renders errored worktree as error group and good worktree in category-first order', () => {
    const views = [
      makeWorktreeChangesView({ label: 'bad', error: 'boom', staged: [makeChangedFileView({ changeId: '1', status: 'added', path: 'src/a.ts' })] }),
      makeWorktreeChangesView({ label: 'good', staged: [makeChangedFileView({ changeId: '2', status: 'added', path: 'src/b.ts' })] }),
    ];
    const specs = [makeSpec('/wt/bad'), makeSpec('/wt/good')];
    const groups = buildScmGroups(makeSnapshot(views), specs);

    expect(groups.map((g) => g.id)).toEqual(['staged-good', 'error-bad']);
    expect(groups.map((g) => g.label)).toEqual(['Staged — good', 'Error — bad: boom']);
  });

  it('omits empty categories', () => {
    const views = [
      makeWorktreeChangesView({
        label: 'repo',
        commits: [
          {
            hash: 'abc123',
            shortHash: 'abc123',
            subject: 'feat: add',
            author: 'author',
            authoredAt: '2024-01-01T00:00:00Z',
            files: [makeChangedFileView({ changeId: '1', status: 'added', path: 'src/a.ts' })],
          },
        ],
      }),
    ];
    const specs = [makeSpec('/wt/repo')];
    const groups = buildScmGroups(makeSnapshot(views), specs);

    expect(groups.map((g) => g.id)).toEqual(['commits-repo']);
    expect(groups.map((g) => g.label)).toEqual(['Commits — repo']);
  });

  it('computes absolutePath correctly for nested paths', () => {
    const views = [
      makeWorktreeChangesView({
        staged: [makeChangedFileView({ changeId: '1', status: 'added', path: 'src/a/b.ts' })],
      }),
    ];
    const specs = [makeSpec('/wt/repo')];
    const groups = buildScmGroups(makeSnapshot(views), specs);

    expect(groups.length).toBeGreaterThan(0);
    expect(groups[0]!.resources.length).toBeGreaterThan(0);
    expect(groups[0]!.resources[0]!.absolutePath).toBe('/wt/repo/src/a/b.ts');
  });

  it('skips commit with zero files', () => {
    const views = [
      makeWorktreeChangesView({
        commits: [
          {
            hash: 'abc123',
            shortHash: 'abc123',
            subject: 'empty commit',
            author: 'author',
            authoredAt: '2024-01-01T00:00:00Z',
            files: [],
          },
          {
            hash: 'def456',
            shortHash: 'def456',
            subject: 'with file',
            author: 'author',
            authoredAt: '2024-01-01T00:00:00Z',
            files: [makeChangedFileView({ changeId: '1', status: 'added', path: 'src/a.ts' })],
          },
        ],
      }),
    ];
    const specs = [makeSpec('/wt/repo')];
    const groups = buildScmGroups(makeSnapshot(views), specs);

    expect(groups.map((g) => g.id)).toEqual(['commits-repo']);
  });

  it('skips views beyond specs length', () => {
    const views = [
      makeWorktreeChangesView({ label: 'repo1', staged: [makeChangedFileView({ changeId: '1', status: 'added', path: 'a.ts' })] }),
      makeWorktreeChangesView({ label: 'repo2', staged: [makeChangedFileView({ changeId: '2', status: 'added', path: 'b.ts' })] }),
      makeWorktreeChangesView({ label: 'repo3', staged: [makeChangedFileView({ changeId: '3', status: 'added', path: 'c.ts' })] }),
    ];
    const specs = [makeSpec('/wt/repo1'), makeSpec('/wt/repo2')];
    const groups = buildScmGroups(makeSnapshot(views), specs);

    expect(groups.map((g) => g.id)).toEqual(['staged-repo1', 'staged-repo2']);
  });

  it('categories are ordered: staged, unstaged, untracked, commits', () => {
    const views = [
      makeWorktreeChangesView({
        label: 'repo',
        staged: [makeChangedFileView({ changeId: 's', status: 'added', path: 's.ts' })],
        unstaged: [makeChangedFileView({ changeId: 'u', status: 'modified', path: 'u.ts' })],
        untracked: [makeChangedFileView({ changeId: 'n', status: 'added', path: 'n.ts' })],
        commits: [
          {
            hash: 'aaa111',
            shortHash: 'aaa111',
            subject: 'feat: commit',
            author: 'author',
            authoredAt: '2024-01-01T00:00:00Z',
            files: [makeChangedFileView({ changeId: 'c', status: 'modified', path: 'c.ts' })],
          },
        ],
      }),
    ];
    const specs = [makeSpec('/wt/repo')];
    const groups = buildScmGroups(makeSnapshot(views), specs);

    expect(groups.map((g) => g.id)).toEqual([
      'staged-repo',
      'unstaged-repo',
      'untracked-repo',
      'commits-repo',
    ]);
  });

  it('error groups appear after all other categories', () => {
    const views = [
      makeWorktreeChangesView({
        label: 'good',
        staged: [makeChangedFileView({ changeId: '1', status: 'added', path: 'a.ts' })],
      }),
      makeWorktreeChangesView({
        label: 'bad',
        error: 'inspection failed',
      }),
    ];
    const specs = [makeSpec('/wt/good'), makeSpec('/wt/bad')];
    const groups = buildScmGroups(makeSnapshot(views), specs);

    expect(groups.map((g) => g.id)).toEqual(['staged-good', 'error-bad']);
    expect(groups.map((g) => g.label)).toEqual(['Staged — good', 'Error — bad: inspection failed']);
    expect(groups[1]!.resources).toEqual([]);
  });

  it('multiple repos under same category are grouped together', () => {
    const views = [
      makeWorktreeChangesView({
        label: 'backend',
        unstaged: [makeChangedFileView({ changeId: 'b1', status: 'modified', path: 'src/api.ts' })],
      }),
      makeWorktreeChangesView({
        label: 'frontend',
        unstaged: [makeChangedFileView({ changeId: 'f1', status: 'modified', path: 'src/app.ts' })],
      }),
      makeWorktreeChangesView({
        label: 'infra',
        unstaged: [makeChangedFileView({ changeId: 'i1', status: 'modified', path: 'main.tf' })],
      }),
    ];
    const specs = [makeSpec('/wt/backend'), makeSpec('/wt/frontend'), makeSpec('/wt/infra')];
    const groups = buildScmGroups(makeSnapshot(views), specs);

    expect(groups.map((g) => g.id)).toEqual([
      'unstaged-backend',
      'unstaged-frontend',
      'unstaged-infra',
    ]);
  });

  it('empty snapshot returns no groups', () => {
    const groups = buildScmGroups(makeSnapshot([]), []);
    expect(groups).toEqual([]);
  });
});