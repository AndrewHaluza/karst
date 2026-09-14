import { describe, it, expect } from 'vitest';
import type { FileChangeStatus } from './git.js';
import type { TicketChangesSnapshot, WorktreeChangesView } from './snapshot.js';
import { buildScmGroups, changeUri, type ScmGroupModel } from './scmModel.js';

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

function makeSpec(path: string, label = 'repo'): { label: string; path: string; branch: string | null; baseRef: string | null } {
  return { label, path, branch: 'main', baseRef: 'develop' };
}

describe('buildScmGroups', () => {
  it('emits one group per category across repos', () => {
    const views = [
      makeWorktreeChangesView({ label: 'backend', unstaged: [makeChangedFileView({ changeId: '1', status: 'modified', path: 'src/a.ts' })] }),
      makeWorktreeChangesView({ label: 'frontend', unstaged: [makeChangedFileView({ changeId: '2', status: 'modified', path: 'src/b.ts' })] }),
      makeWorktreeChangesView({ label: 'infra', unstaged: [makeChangedFileView({ changeId: '3', status: 'modified', path: 'main.tf' })] }),
    ];
    const specs = [makeSpec('/wt/backend', 'backend'), makeSpec('/wt/frontend', 'frontend'), makeSpec('/wt/infra', 'infra')];
    const groups = buildScmGroups(makeSnapshot(views), specs);

    expect(groups.map((g) => g.id)).toEqual(['unstaged']);
    expect(groups[0]!.resources).toHaveLength(3);
  });

  it('orders and labels the categories', () => {
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

    expect(groups.map((g) => g.id)).toEqual(['staged', 'unstaged', 'untracked', 'commit-repo-aaa111']);
    expect(groups.map((g) => g.label)).toEqual(['Staged Changes', 'Changes', 'Untracked', 'aaa111 — feat: commit (repo)']);
  });

  it('sorts rows by repoLabel then path', () => {
    const views = [
      makeWorktreeChangesView({
        label: 'zeta',
        unstaged: [
          makeChangedFileView({ changeId: '1', status: 'modified', path: 'src/b.ts' }),
          makeChangedFileView({ changeId: '2', status: 'modified', path: 'src/a.ts' }),
        ],
      }),
      makeWorktreeChangesView({
        label: 'alpha',
        unstaged: [makeChangedFileView({ changeId: '3', status: 'modified', path: 'm.ts' })],
      }),
    ];
    const specs = [makeSpec('/wt/zeta', 'zeta'), makeSpec('/wt/alpha', 'alpha')];
    const groups = buildScmGroups(makeSnapshot(views), specs);

    const unstaged = groups.find((g) => g.id === 'unstaged')!;
    expect(unstaged.resources.map((r) => `${r.repoLabel}/${r.path}`)).toEqual([
      'alpha/m.ts',
      'zeta/src/a.ts',
      'zeta/src/b.ts',
    ]);
  });

  it('gives two commits in one repo distinct ids', () => {
    const views = [
      makeWorktreeChangesView({
        label: 'repo',
        commits: [
          {
            hash: 'aaa111xxxx',
            shortHash: 'aaa111',
            subject: 'first',
            author: 'author',
            authoredAt: '2024-01-01T00:00:00Z',
            files: [makeChangedFileView({ changeId: '1', status: 'modified', path: 'a.ts' })],
          },
          {
            hash: 'bbb222xxxx',
            shortHash: 'bbb222',
            subject: 'second',
            author: 'author',
            authoredAt: '2024-01-02T00:00:00Z',
            files: [makeChangedFileView({ changeId: '2', status: 'modified', path: 'b.ts' })],
          },
        ],
      }),
    ];
    const specs = [makeSpec('/wt/repo')];
    const groups = buildScmGroups(makeSnapshot(views), specs);

    expect(groups.map((g) => g.id)).toEqual(['commit-repo-aaa111', 'commit-repo-bbb222']);
  });

  it('skips a commit with no files', () => {
    const views = [
      makeWorktreeChangesView({
        label: 'repo',
        commits: [
          {
            hash: 'aaa111xxxx',
            shortHash: 'aaa111',
            subject: 'empty commit',
            author: 'author',
            authoredAt: '2024-01-01T00:00:00Z',
            files: [],
          },
          {
            hash: 'bbb222xxxx',
            shortHash: 'bbb222',
            subject: 'with file',
            author: 'author',
            authoredAt: '2024-01-02T00:00:00Z',
            files: [makeChangedFileView({ changeId: '1', status: 'added', path: 'src/a.ts' })],
          },
        ],
      }),
    ];
    const specs = [makeSpec('/wt/repo')];
    const groups = buildScmGroups(makeSnapshot(views), specs);

    expect(groups.map((g) => g.id)).toEqual(['commit-repo-bbb222']);
  });

  it('places error groups last', () => {
    const views = [
      makeWorktreeChangesView({
        label: 'good',
        staged: [makeChangedFileView({ changeId: '1', status: 'added', path: 'a.ts' })],
      }),
      makeWorktreeChangesView({ label: 'bad', error: 'inspection failed' }),
    ];
    const specs = [makeSpec('/wt/good', 'good'), makeSpec('/wt/bad', 'bad')];
    const groups = buildScmGroups(makeSnapshot(views), specs);

    expect(groups.map((g) => g.id)).toEqual(['staged', 'error-bad']);
    expect(groups.map((g) => g.label)).toEqual(['Staged Changes', 'Error — bad: inspection failed']);
    expect(groups[1]!.resources).toEqual([]);
  });

  it('skips views beyond specs length', () => {
    const views = [
      makeWorktreeChangesView({ label: 'repo1', staged: [makeChangedFileView({ changeId: '1', status: 'added', path: 'a.ts' })] }),
      makeWorktreeChangesView({ label: 'repo2', staged: [makeChangedFileView({ changeId: '2', status: 'added', path: 'b.ts' })] }),
      makeWorktreeChangesView({ label: 'repo3', staged: [makeChangedFileView({ changeId: '3', status: 'added', path: 'c.ts' })] }),
    ];
    const specs = [makeSpec('/wt/repo1', 'repo1'), makeSpec('/wt/repo2', 'repo2')];
    const groups = buildScmGroups(makeSnapshot(views), specs);

    expect(groups.map((g) => g.id)).toEqual(['staged']);
    expect(groups[0]!.resources.map((r) => `${r.repoLabel}/${r.path}`)).toEqual(['repo1/a.ts', 'repo2/b.ts']);
  });

  it('populates each row with its repository identity', () => {
    const views = [
      makeWorktreeChangesView({
        label: 'backend',
        staged: [makeChangedFileView({ changeId: '1', status: 'added', path: 'src/a/b.ts' })],
      }),
    ];
    const specs = [makeSpec('/wt/backend', 'backend')];
    const groups = buildScmGroups(makeSnapshot(views), specs);

    const resource = groups[0]!.resources[0]!;
    expect(resource).toMatchObject({
      absolutePath: '/wt/backend/src/a/b.ts',
      repoLabel: 'backend',
      repoPath: '/wt/backend',
      category: 'staged',
      uri: 'karst-change:/backend/src/a/b.ts',
    });
  });

  it('returns no groups for an empty snapshot', () => {
    const groups = buildScmGroups(makeSnapshot([]), []);
    expect(groups).toEqual([]);
  });
});

describe('changeUri', () => {
  it('encodes each segment', () => {
    expect(changeUri('back end', 'src/a b.ts')).toBe('karst-change:/back%20end/src/a%20b.ts');
  });
});
