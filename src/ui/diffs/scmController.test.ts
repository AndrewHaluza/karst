import { describe, it, expect, vi, type MockedFunction } from 'vitest';
import type { DiffTarget, WorktreeSpec, FileChangeStatus } from './git.js';
import type { TicketChangesSnapshot, WorktreeChangesView, ChangedFileView } from './snapshot.js';
import { TicketScmController, type ScmHost, type ScmViewHandle, type ScmGroupHandle, type ScmResourceHandleInput } from './scmController.js';

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

function makeChangedFileView(overrides: { changeId: string; status: FileChangeStatus; path: string; oldPath?: string | null } = { changeId: 'a', status: 'added', path: 'file.ts' }): ChangedFileView {
  return {
    changeId: overrides.changeId,
    status: overrides.status,
    path: overrides.path,
    oldPath: overrides.oldPath ?? null,
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

function makeSpec(path: string): WorktreeSpec {
  return { label: 'repo', path, branch: 'main', baseRef: 'develop' };
}

function makeTarget(): DiffTarget {
  return {
    repoLabel: 'repo',
    groupLabel: 'Staged Changes',
    displayPath: 'file.ts',
    left: { kind: 'empty', label: 'HEAD' },
    right: { kind: 'working', path: 'file.ts', label: 'Working Tree' },
  };
}

function createFakeHost(): ScmHost & { _testOnly: { view: ScmViewHandle & { createGroup: MockedFunction<(id: string, label: string) => ScmGroupHandle> }; createdGroups: Array<ScmGroupHandle & { setResources: MockedFunction<(resources: readonly ScmResourceHandleInput[]) => void>; dispose: MockedFunction<() => void> }> } } {
  type MockedGroupHandle = ScmGroupHandle & { setResources: MockedFunction<(resources: readonly ScmResourceHandleInput[]) => void>; dispose: MockedFunction<() => void> };
  const createdGroups: Array<MockedGroupHandle> = [];
  const createGroupMock: MockedFunction<(id: string, label: string) => MockedGroupHandle> = vi.fn((id: string, label: string) => {
    const group: MockedGroupHandle = {
      setResources: vi.fn(),
      dispose: vi.fn(),
    };
    createdGroups.push(group);
    return group;
  });
  const view: ScmViewHandle & { createGroup: MockedFunction<(id: string, label: string) => ScmGroupHandle> } = {
    setTitle: vi.fn(),
    createGroup: createGroupMock,
    dispose: vi.fn(),
  };
  const host: ScmHost = {
    createView: vi.fn(() => view),
    focus: vi.fn(() => Promise.resolve()),
    warn: vi.fn(),
    _testOnly: { view, createdGroups },
  };
  return host as ScmHost & { _testOnly: { view: ScmViewHandle & { createGroup: MockedFunction<(id: string, label: string) => ScmGroupHandle> }; createdGroups: Array<ScmGroupHandle & { setResources: MockedFunction<(resources: readonly ScmResourceHandleInput[]) => void>; dispose: MockedFunction<() => void> }> } };
}

describe('TicketScmController', () => {
  it('renders groups in model order with resources carrying changeId and absolutePath; focus called once', async () => {
    const host = createFakeHost();
    const views = [
      makeWorktreeChangesView({
        label: 'backend',
        staged: [makeChangedFileView({ changeId: '1', status: 'added', path: 'src/a.ts' })],
        unstaged: [makeChangedFileView({ changeId: '2', status: 'modified', path: 'src/b.ts' })],
        commits: [
          {
            hash: 'abc123',
            shortHash: 'abc123',
            subject: 'feat: add',
            author: 'author',
            authoredAt: '2024-01-01T00:00:00Z',
            files: [makeChangedFileView({ changeId: '3', status: 'modified', path: 'src/c.ts' })],
          },
        ],
      }),
    ];
    const specs = [makeSpec('/wt/backend')];
    const load = vi.fn().mockResolvedValue({ snapshot: makeSnapshot(views), worktrees: specs });
    const openDiff = vi.fn().mockResolvedValue(undefined);
    const logError = vi.fn();
    const titleFor = vi.fn(() => 'Karst — TEST-1 — title');

    const controller = new TicketScmController({
      host,
      load,
      openDiff,
      logError,
      titleFor,
    });

    await controller.show(1);

    expect(host.createView).toHaveBeenCalledTimes(1);
    expect(host.createView).toHaveBeenCalledWith('karst', 'Karst — TEST-1 — title');
    expect(host.focus).toHaveBeenCalledTimes(1);

    const createdView = host._testOnly.view;
    // First show: title is passed to createView, not setTitle
    expect(createdView.createGroup).toHaveBeenCalledTimes(3); // staged, unstaged, commit

    const groups = (createdView.createGroup as MockedFunction<typeof createdView.createGroup>).mock.calls;
    expect(groups[0]).toEqual(['w0-staged', 'backend — Staged']);
    expect(groups[1]).toEqual(['w0-unstaged', 'backend — Unstaged']);
    expect(groups[2]).toEqual(['w0-c0', 'backend — abc123 feat: add']);

    const setResourcesCalls = host._testOnly.createdGroups.map((g: typeof host._testOnly.createdGroups[number]) => (g.setResources as MockedFunction<typeof g.setResources>).mock.calls!);
    expect(setResourcesCalls[0]![0]![0][0]).toMatchObject({
      changeId: '1',
      absolutePath: '/wt/backend/src/a.ts',
      status: 'added',
    });
    expect(setResourcesCalls[1]![0]![0][0]).toMatchObject({
      changeId: '2',
      absolutePath: '/wt/backend/src/b.ts',
      status: 'modified',
    });
    expect(setResourcesCalls[2]![0]![0][0]).toMatchObject({
      changeId: '3',
      absolutePath: '/wt/backend/src/c.ts',
      status: 'modified',
    });
  });

  it('reuses the view for the same ticket and disposes previous groups', async () => {
    const host = createFakeHost();
    const views = [
      makeWorktreeChangesView({
        label: 'repo',
        staged: [makeChangedFileView({ changeId: '1', status: 'added', path: 'src/a.ts' })],
      }),
    ];
    const specs = [makeSpec('/wt/repo')];
    const load = vi.fn().mockResolvedValue({ snapshot: makeSnapshot(views), worktrees: specs });
    const openDiff = vi.fn().mockResolvedValue(undefined);
    const logError = vi.fn();
    const titleFor = vi.fn(() => 'Karst — TEST-1 — title');

    const controller = new TicketScmController({
      host,
      load,
      openDiff,
      logError,
      titleFor,
    });

    await controller.show(1);
    await controller.show(1);

    expect(host.createView).toHaveBeenCalledTimes(1);
    const view = host._testOnly.view;
    // First show: title via createView, createGroup called once
    // Second show (same ticket): setTitle called once, createGroup called again (old disposed, new created)
    expect((view.setTitle as MockedFunction<typeof view.setTitle>).mock.calls!).toHaveLength(1);
    expect((view.createGroup as MockedFunction<typeof view.createGroup>).mock.calls!).toHaveLength(2);
  });

  it('disposes previous view and creates new one for different ticket', async () => {
    const host = createFakeHost();
    const views1 = [
      makeWorktreeChangesView({ label: 'repo1', staged: [makeChangedFileView({ changeId: '1', status: 'added', path: 'a.ts' })] }),
    ];
    const views2 = [
      makeWorktreeChangesView({ label: 'repo2', staged: [makeChangedFileView({ changeId: '2', status: 'added', path: 'b.ts' })] }),
    ];
    const specs = [makeSpec('/wt/repo1'), makeSpec('/wt/repo2')];
    const load = vi
      .fn()
      .mockResolvedValueOnce({ snapshot: makeSnapshot(views1), worktrees: specs.slice(0, 1) })
      .mockResolvedValueOnce({ snapshot: makeSnapshot(views2), worktrees: specs.slice(1, 2) });
    const openDiff = vi.fn().mockResolvedValue(undefined);
    const logError = vi.fn();
    const titleFor = vi.fn((id: number) => `Karst — TEST-${id} — title`);

    const controller = new TicketScmController({
      host,
      load,
      openDiff,
      logError,
      titleFor,
    });

    await controller.show(1);
    await controller.show(2);

    expect(host.createView).toHaveBeenCalledTimes(2);
    expect(host.createView).toHaveBeenNthCalledWith(1, 'karst', 'Karst — TEST-1 — title');
    expect(host.createView).toHaveBeenNthCalledWith(2, 'karst', 'Karst — TEST-2 — title');
    // The first view should be disposed when the second show runs
    const results = (host.createView as MockedFunction<typeof host.createView>).mock!.results!;
    const firstView = results[0]!.value;
    expect((firstView.dispose as MockedFunction<typeof firstView.dispose>).mock.calls!).toHaveLength(1);
  });

  it('load rejection calls logError and warn, no createView on first show', async () => {
    const host = createFakeHost();
    const load = vi.fn().mockRejectedValue(new Error('load failed'));
    const openDiff = vi.fn().mockResolvedValue(undefined);
    const logError = vi.fn();
    const titleFor = vi.fn(() => 'Karst — TEST-1 — title');

    const controller = new TicketScmController({
      host,
      load,
      openDiff,
      logError,
      titleFor,
    });

    await controller.show(1);

    expect(logError).toHaveBeenCalledWith('karst: loading ticket changes for Source Control failed', expect.any(Error));
    expect(host.warn).toHaveBeenCalledWith('load failed');
    expect(host.createView).not.toHaveBeenCalled();
  });

  it('openChange with known id calls openDiff with mapped target', async () => {
    const host = createFakeHost();
    const target = makeTarget();
    const views = [makeWorktreeChangesView({ staged: [makeChangedFileView({ changeId: '1', status: 'added', path: 'file.ts' })] })];
    const specs = [makeSpec('/wt/repo')];
    const load = vi.fn().mockResolvedValue({
      snapshot: { ...makeSnapshot(views), targets: new Map([['1', target]]) },
      worktrees: specs,
    });
    const openDiff = vi.fn().mockResolvedValue(undefined);
    const logError = vi.fn();
    const titleFor = vi.fn(() => 'Karst — TEST-1 — title');

    const controller = new TicketScmController({
      host,
      load,
      openDiff,
      logError,
      titleFor,
    });

    await controller.show(1);
    await controller.openChange('1');

    expect(openDiff).toHaveBeenCalledTimes(1);
    expect(openDiff).toHaveBeenCalledWith(target);
  });

  it('openChange with unknown id warns and does not call openDiff', async () => {
    const host = createFakeHost();
    const views = [makeWorktreeChangesView({ staged: [] })];
    const specs = [makeSpec('/wt/repo')];
    const load = vi.fn().mockResolvedValue({ snapshot: makeSnapshot(views), worktrees: specs });
    const openDiff = vi.fn().mockResolvedValue(undefined);
    const logError = vi.fn();
    const titleFor = vi.fn(() => 'Karst — TEST-1 — title');

    const controller = new TicketScmController({
      host,
      load,
      openDiff,
      logError,
      titleFor,
    });

    await controller.show(1);
    await controller.openChange('unknown');

    expect(host.warn).toHaveBeenCalledWith('That change is no longer available. Reopen changes for this ticket.');
    expect(openDiff).not.toHaveBeenCalled();
  });

  it('openDiff rejection calls warn and logError, method resolves', async () => {
    const host = createFakeHost();
    const target = makeTarget();
    const views = [makeWorktreeChangesView({ staged: [makeChangedFileView({ changeId: '1', status: 'added', path: 'file.ts' })] })];
    const specs = [makeSpec('/wt/repo')];
    const load = vi.fn().mockResolvedValue({
      snapshot: { ...makeSnapshot(views), targets: new Map([['1', target]]) },
      worktrees: specs,
    });
    const openDiff = vi.fn().mockRejectedValue(new Error('diff failed'));
    const logError = vi.fn();
    const titleFor = vi.fn(() => 'Karst — TEST-1 — title');

    const controller = new TicketScmController({
      host,
      load,
      openDiff,
      logError,
      titleFor,
    });

    await controller.show(1);
    await controller.openChange('1');

    expect(logError).toHaveBeenCalledWith('karst: opening diff from Source Control failed', expect.any(Error));
    expect(host.warn).toHaveBeenCalledWith('diff failed');
  });

  it('stale show is abandoned when newer show starts', async () => {
    const host = createFakeHost();
    let resolveFirst: (value: { snapshot: TicketChangesSnapshot; worktrees: readonly WorktreeSpec[] }) => void;
    const firstPromise = new Promise<{ snapshot: TicketChangesSnapshot; worktrees: readonly WorktreeSpec[] }>((resolve) => {
      resolveFirst = resolve;
    });

    const views1 = [makeWorktreeChangesView({ label: 'repo1', staged: [makeChangedFileView({ changeId: '1', status: 'added', path: 'a.ts' })] })];
    const views2 = [makeWorktreeChangesView({ label: 'repo2', staged: [makeChangedFileView({ changeId: '2', status: 'added', path: 'b.ts' })] })];
    const specs = [makeSpec('/wt/repo1'), makeSpec('/wt/repo2')];

    const load = vi
      .fn()
      .mockReturnValueOnce(firstPromise)
      .mockResolvedValueOnce({ snapshot: makeSnapshot(views2), worktrees: specs.slice(1, 2) });
    const openDiff = vi.fn().mockResolvedValue(undefined);
    const logError = vi.fn();
    const titleFor = vi.fn((id: number) => `Karst — TEST-${id} — title`);

    const controller = new TicketScmController({
      host,
      load,
      openDiff,
      logError,
      titleFor,
    });

    const show1 = controller.show(1);
    const show2 = controller.show(2);

    resolveFirst!({ snapshot: makeSnapshot(views1), worktrees: specs.slice(0, 1) });

    await Promise.all([show1, show2]);

    // Only the second show should reach the host
    expect(host.createView).toHaveBeenCalledTimes(1);
    expect(host.createView).toHaveBeenCalledWith('karst', 'Karst — TEST-2 — title');
  });

  it('dispose twice does not double-dispose handles', async () => {
    const host = createFakeHost();
    const views = [makeWorktreeChangesView({ staged: [makeChangedFileView({ changeId: '1', status: 'added', path: 'a.ts' })] })];
    const specs = [makeSpec('/wt/repo')];
    const load = vi.fn().mockResolvedValue({ snapshot: makeSnapshot(views), worktrees: specs });
    const openDiff = vi.fn().mockResolvedValue(undefined);
    const logError = vi.fn();
    const titleFor = vi.fn(() => 'Karst — TEST-1 — title');

    const controller = new TicketScmController({
      host,
      load,
      openDiff,
      logError,
      titleFor,
    });

    await controller.show(1);
    controller.dispose();
    controller.dispose();

    const results = (host.createView as MockedFunction<typeof host.createView>).mock!.results!;
    const view = results[0]!.value;
    expect((view.dispose as MockedFunction<typeof view.dispose>).mock.calls!).toHaveLength(1);
  });
});