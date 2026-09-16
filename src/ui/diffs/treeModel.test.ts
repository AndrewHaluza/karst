import { describe, it, expect } from 'vitest';
import type { FileChangeStatus, WorktreeSpec } from './git.js';
import type { TicketChangesSnapshot, WorktreeChangesView } from './snapshot.js';
import { buildDiffTree, diffNodeChangeId, findParentNode, selectorNode, type DiffNode } from './treeModel.js';

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

function makeChangedFileView(
  overrides: { changeId: string; status: FileChangeStatus; path: string; oldPath?: string | null },
): ChangedFile {
  return {
    changeId: overrides.changeId,
    status: overrides.status,
    path: overrides.path,
    oldPath: overrides.oldPath ?? null,
    absolutePath: `/wt/repo/${overrides.path}`,
  };
}

type ChangedFile = WorktreeChangesView['unstaged'][number];

function makeCommit(
  overrides: { shortHash: string; subject: string; files: ChangedFile[] },
) {
  return {
    hash: `${overrides.shortHash}xxxx`,
    shortHash: overrides.shortHash,
    subject: overrides.subject,
    author: 'author',
    authoredAt: '2024-01-01T00:00:00Z',
    files: overrides.files,
  };
}

function makeSnapshot(views: WorktreeChangesView[]): TicketChangesSnapshot {
  return {
    state: {
      ticketId: 1,
      worktreeCount: views.length,
      commitCount: views.reduce((count, view) => count + view.commits.length, 0),
      pendingCount: views.reduce(
        (count, view) => count + view.staged.length + view.unstaged.length + view.untracked.length,
        0,
      ),
      worktrees: views,
    },
    targets: new Map(),
  };
}

function makeSpec(path: string, label = 'repo'): WorktreeSpec {
  return { label, path, branch: 'main', baseRef: 'develop' };
}

function collectIds(nodes: readonly DiffNode[]): string[] {
  return nodes.flatMap((node) => [node.id, ...collectIds(node.children)]);
}

describe('buildDiffTree', () => {
  it('keeps a single-repo pending group flat, with no repo node', () => {
    const views = [
      makeWorktreeChangesView({
        label: 'repo',
        unstaged: [
          makeChangedFileView({ changeId: '1', status: 'modified', path: 'src/a.ts' }),
          makeChangedFileView({ changeId: '2', status: 'modified', path: 'src/b.ts' }),
        ],
      }),
    ];
    const tree = buildDiffTree(makeSnapshot(views), [makeSpec('/wt/repo')]);

    expect(tree.map((node) => node.id)).toEqual(['unstaged']);
    const group = tree[0]!;
    expect(group.kind).toBe('group');
    expect(group.label).toBe('Changes');
    expect(group.description).toBe('2');
    expect(group.children.map((node) => node.kind)).toEqual(['file', 'file']);
    expect(group.children.map((node) => node.changeId)).toEqual(['1', '2']);
  });

  it('adds one repo layer for a pending group spanning two repositories', () => {
    const views = [
      makeWorktreeChangesView({
        label: 'backend',
        unstaged: [makeChangedFileView({ changeId: '1', status: 'modified', path: 'src/a.ts' })],
      }),
      makeWorktreeChangesView({
        label: 'frontend',
        unstaged: [makeChangedFileView({ changeId: '2', status: 'modified', path: 'src/b.ts' })],
      }),
    ];
    const specs = [makeSpec('/wt/backend', 'backend'), makeSpec('/wt/frontend', 'frontend')];
    const tree = buildDiffTree(makeSnapshot(views), specs);

    const group = tree[0]!;
    expect(group.children.map((node) => node.kind)).toEqual(['repo', 'repo']);
    expect(group.children.map((node) => node.label)).toEqual(['backend', 'frontend']);
    expect(group.children[0]!.children.map((node) => node.label)).toEqual(['a.ts']);
    expect(group.children[1]!.children.map((node) => node.label)).toEqual(['b.ts']);
  });

  it('keys the repo layer on repoPath, not repoLabel', () => {
    const views = [
      makeWorktreeChangesView({
        label: 'shared',
        unstaged: [makeChangedFileView({ changeId: '1', status: 'modified', path: 'a.ts' })],
      }),
      makeWorktreeChangesView({
        label: 'shared',
        unstaged: [makeChangedFileView({ changeId: '2', status: 'modified', path: 'b.ts' })],
      }),
      makeWorktreeChangesView({
        label: 'other',
        unstaged: [makeChangedFileView({ changeId: '3', status: 'modified', path: 'c.ts' })],
      }),
    ];
    const specs = [makeSpec('/wt/one'), makeSpec('/wt/two'), makeSpec('/wt/three', 'other')];
    const tree = buildDiffTree(makeSnapshot(views), specs);

    const group = tree[0]!;
    expect(group.children.map((node) => node.kind)).toEqual(['repo', 'repo', 'repo']);
    expect(group.children.map((node) => node.label)).toEqual(['other', 'shared', 'shared']);
  });

  it('parents commits in one repository directly under one Commits node', () => {
    const commitFiles = [makeChangedFileView({ changeId: '1', status: 'modified', path: 'src/a.ts' })];
    const views = [
      makeWorktreeChangesView({
        label: 'repo',
        commits: [
          makeCommit({ shortHash: 'aaa111', subject: 'first', files: commitFiles }),
          makeCommit({ shortHash: 'bbb222', subject: 'second', files: commitFiles }),
        ],
      }),
    ];
    const tree = buildDiffTree(makeSnapshot(views), [makeSpec('/wt/repo')]);

    expect(tree.map((node) => node.id)).toEqual(['commits']);
    const commits = tree[0]!;
    expect(commits.label).toBe('Commits');
    expect(commits.description).toBe('2');
    expect(commits.children.map((node) => node.kind)).toEqual(['commit', 'commit']);
    expect(commits.children.map((node) => node.label)).toEqual(['aaa111 — first', 'bbb222 — second']);
  });

  it('adds a repo layer under Commits when commits span two repositories', () => {
    const file = makeChangedFileView({ changeId: '1', status: 'modified', path: 'src/a.ts' });
    const views = [
      makeWorktreeChangesView({
        label: 'backend',
        commits: [makeCommit({ shortHash: 'aaa111', subject: 'be work', files: [file] })],
      }),
      makeWorktreeChangesView({
        label: 'frontend',
        commits: [makeCommit({ shortHash: 'bbb222', subject: 'fe work', files: [file] })],
      }),
    ];
    const specs = [makeSpec('/wt/backend', 'backend'), makeSpec('/wt/frontend', 'frontend')];
    const tree = buildDiffTree(makeSnapshot(views), specs);

    const commits = tree[0]!;
    expect(commits.children.map((node) => node.kind)).toEqual(['repo', 'repo']);
    expect(commits.children.map((node) => node.label)).toEqual(['backend', 'frontend']);
    expect(commits.children.map((node) => node.description)).toEqual(['1', '1']);
    expect(commits.children[0]!.children[0]!.kind).toBe('commit');
  });

  it('strips the repo suffix from a commit node label', () => {
    const file = makeChangedFileView({ changeId: '1', status: 'modified', path: 'src/a.ts' });
    const views = [
      makeWorktreeChangesView({
        label: 'repo',
        commits: [makeCommit({ shortHash: 'aaa111', subject: 'feat: thing', files: [file] })],
      }),
    ];
    const tree = buildDiffTree(makeSnapshot(views), [makeSpec('/wt/repo')]);

    expect(tree[0]!.children[0]!.label).toBe('aaa111 — feat: thing');
  });

  it('keeps a commit subject that itself ends in parentheses', () => {
    const file = makeChangedFileView({ changeId: '1', status: 'modified', path: 'src/a.ts' });
    const views = [
      makeWorktreeChangesView({
        label: 'repo',
        commits: [makeCommit({ shortHash: 'aaa111', subject: 'fix: thing (v2)', files: [file] })],
      }),
    ];
    const tree = buildDiffTree(makeSnapshot(views), [makeSpec('/wt/repo')]);

    expect(tree[0]!.children[0]!.label).toBe('aaa111 — fix: thing (v2)');
  });

  it('omits the Commits node when there are only pending changes', () => {
    const views = [
      makeWorktreeChangesView({
        label: 'repo',
        unstaged: [makeChangedFileView({ changeId: '1', status: 'modified', path: 'a.ts' })],
      }),
    ];
    const tree = buildDiffTree(makeSnapshot(views), [makeSpec('/wt/repo')]);

    expect(tree.map((node) => node.id)).toEqual(['unstaged']);
  });

  it('emits an error node with no children', () => {
    const views = [
      makeWorktreeChangesView({
        label: 'good',
        staged: [makeChangedFileView({ changeId: '1', status: 'added', path: 'a.ts' })],
      }),
      makeWorktreeChangesView({ label: 'bad', error: 'inspection failed' }),
    ];
    const specs = [makeSpec('/wt/good', 'good'), makeSpec('/wt/bad', 'bad')];
    const tree = buildDiffTree(makeSnapshot(views), specs);

    expect(tree.map((node) => node.kind)).toEqual(['group', 'error']);
    const error = tree[1]!;
    expect(error.label).toBe('Error — bad: inspection failed');
    expect(error.children).toEqual([]);
  });

  it('gives a repository-root file an empty description', () => {
    const views = [
      makeWorktreeChangesView({
        label: 'repo',
        unstaged: [makeChangedFileView({ changeId: '1', status: 'modified', path: 'a.ts' })],
      }),
    ];
    const tree = buildDiffTree(makeSnapshot(views), [makeSpec('/wt/repo')]);

    const file = tree[0]!.children[0]!;
    expect(file.label).toBe('a.ts');
    expect(file.description).toBe('');
  });

  it('splits label from dirname for a nested file', () => {
    const views = [
      makeWorktreeChangesView({
        label: 'repo',
        unstaged: [makeChangedFileView({ changeId: '1', status: 'modified', path: 'src/api/a.ts' })],
      }),
    ];
    const tree = buildDiffTree(makeSnapshot(views), [makeSpec('/wt/repo')]);

    const file = tree[0]!.children[0]!;
    expect(file.label).toBe('a.ts');
    expect(file.description).toBe('src/api');
  });

  it('counts a group description over files nested under repo nodes', () => {
    const views = [
      makeWorktreeChangesView({
        label: 'backend',
        unstaged: [
          makeChangedFileView({ changeId: '1', status: 'modified', path: 'a.ts' }),
          makeChangedFileView({ changeId: '2', status: 'modified', path: 'b.ts' }),
        ],
      }),
      makeWorktreeChangesView({
        label: 'frontend',
        unstaged: [makeChangedFileView({ changeId: '3', status: 'modified', path: 'c.ts' })],
      }),
    ];
    const specs = [makeSpec('/wt/backend', 'backend'), makeSpec('/wt/frontend', 'frontend')];
    const tree = buildDiffTree(makeSnapshot(views), specs);

    expect(tree[0]!.children.map((node) => node.kind)).toEqual(['repo', 'repo']);
    expect(tree[0]!.description).toBe('3');
  });

  it('keeps node ids unique across the whole tree', () => {
    const file = (changeId: string) =>
      makeChangedFileView({ changeId, status: 'modified', path: 'src/a.ts' });
    const views = [
      makeWorktreeChangesView({
        label: 'backend',
        staged: [file('1')],
        unstaged: [file('2')],
        commits: [makeCommit({ shortHash: 'aaa111', subject: 'be work', files: [file('3')] })],
      }),
      makeWorktreeChangesView({
        label: 'frontend',
        unstaged: [makeChangedFileView({ changeId: '4', status: 'modified', path: 'src/b.ts' })],
        commits: [makeCommit({ shortHash: 'bbb222', subject: 'fe work', files: [file('5')] })],
      }),
      makeWorktreeChangesView({ label: 'bad', error: 'inspection failed' }),
    ];
    const specs = [
      makeSpec('/wt/backend', 'backend'),
      makeSpec('/wt/frontend', 'frontend'),
      makeSpec('/wt/bad', 'bad'),
    ];
    const ids = collectIds(buildDiffTree(makeSnapshot(views), specs));

    expect(new Set(ids).size).toBe(ids.length);
  });

  it('returns no nodes for an empty snapshot', () => {
    expect(buildDiffTree(makeSnapshot([]), [])).toEqual([]);
  });
});

describe('selectorNode', () => {
  it('builds a childless selector node', () => {
    expect(selectorNode('Working tree', '2 files')).toEqual({
      kind: 'selector',
      id: 'selector',
      label: 'Working tree',
      description: '2 files',
      children: [],
    });
  });
});

describe('diffNodeChangeId', () => {
  it('accepts a bare non-empty string', () => {
    expect(diffNodeChangeId('abc')).toBe('abc');
  });

  it('reads changeId from a node', () => {
    expect(diffNodeChangeId({ changeId: 'node-1' })).toBe('node-1');
  });

  it('returns undefined for a node without changeId', () => {
    expect(diffNodeChangeId({ label: 'group' })).toBeUndefined();
  });

  it('returns undefined for undefined', () => {
    expect(diffNodeChangeId(undefined)).toBeUndefined();
  });

  it('returns undefined for a non-object primitive', () => {
    expect(diffNodeChangeId(42)).toBeUndefined();
  });
});

describe('findParentNode', () => {
  const file: DiffNode = {
    kind: 'file',
    id: 'f1',
    label: 'a.ts',
    description: 'src',
    children: [],
    changeId: 'f1',
  };
  const repo: DiffNode = {
    kind: 'repo',
    id: 'unstaged:/wt/be',
    label: 'be',
    description: '1',
    children: [file],
    category: 'unstaged',
  };
  const group: DiffNode = {
    kind: 'group',
    id: 'unstaged',
    label: 'Changes',
    description: '1',
    children: [repo],
  };
  const selector: DiffNode = selectorNode('x', '');

  it('returns undefined for a root', () => {
    expect(findParentNode([selector, group], 'selector')).toBeUndefined();
    expect(findParentNode([selector, group], 'unstaged')).toBeUndefined();
  });

  it('returns the immediate parent for a direct child', () => {
    expect(findParentNode([selector, group], 'unstaged:/wt/be')).toBe(group);
  });

  it('returns the nested parent for a deeply nested node', () => {
    expect(findParentNode([selector, group], 'f1')).toBe(repo);
  });

  it('returns undefined for an absent id', () => {
    expect(findParentNode([selector, group], 'nope')).toBeUndefined();
  });
});
