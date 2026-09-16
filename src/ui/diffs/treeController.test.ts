import { describe, it, expect, vi } from 'vitest';
import type { DiffTarget, FileChangeStatus, WorktreeSpec } from './git.js';
import type { TicketChangesSnapshot, WorktreeChangesView } from './snapshot.js';
import { DiffTreeController, type DiffTreeControllerDeps, type DiffTreeHost } from './treeController.js';

type ChangedFile = WorktreeChangesView['unstaged'][number];

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

function makeSnapshot(
  views: WorktreeChangesView[],
  targets: ReadonlyMap<string, DiffTarget> = new Map(),
): TicketChangesSnapshot {
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
    targets,
  };
}

function makeSpec(path: string, label = 'repo'): WorktreeSpec {
  return { label, path, branch: 'main', baseRef: 'develop' };
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

function createFakeHost(): DiffTreeHost {
  return {
    refresh: vi.fn(),
    reveal: vi.fn(() => Promise.resolve()),
    warn: vi.fn(),
    viewColumn: vi.fn(() => 1),
  };
}

function makeDeps(
  host: DiffTreeHost,
  overrides: Partial<DiffTreeControllerDeps> = {},
): DiffTreeControllerDeps {
  return {
    host,
    load: vi.fn().mockResolvedValue({ snapshot: makeSnapshot([]), worktrees: [] }),
    openDiff: vi.fn().mockResolvedValue(undefined),
    logError: vi.fn(),
    labelFor: vi.fn((ticketId: number) => `FEAT-${ticketId} — title`),
    openFile: vi.fn(),
    discard: vi.fn().mockResolvedValue({ ok: true }),
    unstage: vi.fn().mockResolvedValue({ ok: true }),
    confirmDiscard: vi.fn().mockResolvedValue(true),
    ...overrides,
  };
}

describe('DiffTreeController', () => {
  it('roots() with no ticket returns only the placeholder selector', () => {
    const controller = new DiffTreeController(makeDeps(createFakeHost()));

    const roots = controller.roots();

    expect(roots).toHaveLength(1);
    expect(roots[0]).toMatchObject({ kind: 'selector', label: 'Select a ticket…' });
  });

  it('roots() returns stable node identity between calls so reveal can match', () => {
    const controller = new DiffTreeController(makeDeps(createFakeHost()));

    const first = controller.roots();

    expect(controller.roots()).toBe(first);
    expect(controller.roots()[0]).toBe(first[0]);
  });

  it('after a successful show, roots lead with the named selector and the tree follows', async () => {
    const host = createFakeHost();
    const views = [
      makeWorktreeChangesView({
        label: 'backend',
        unstaged: [makeChangedFileView({ changeId: '1', status: 'modified', path: 'src/a.ts' })],
      }),
    ];
    const load = vi.fn().mockResolvedValue({
      snapshot: makeSnapshot(views),
      worktrees: [makeSpec('/wt/backend', 'backend')],
    });
    const controller = new DiffTreeController(makeDeps(host, { load }));

    await controller.show(7);

    const roots = controller.roots();
    expect(roots[0]).toMatchObject({ kind: 'selector', label: 'FEAT-7 — title' });
    expect(roots.slice(1).map((node) => node.id)).toEqual(['unstaged']);
  });

  it('show calls refresh() then reveal(), in that order', async () => {
    const host = createFakeHost();
    const controller = new DiffTreeController(makeDeps(host));

    await controller.show(1);

    expect(vi.mocked(host.refresh)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(host.reveal)).toHaveBeenCalledTimes(1);
    const refreshOrder = vi.mocked(host.refresh).mock.invocationCallOrder[0];
    const revealOrder = vi.mocked(host.reveal).mock.invocationCallOrder[0];
    expect(refreshOrder).toBeLessThan(revealOrder!);
  });

  it('a load rejection calls logError and warn and leaves nodes empty', async () => {
    const host = createFakeHost();
    const logError = vi.fn();
    const load = vi.fn().mockRejectedValue(new Error('load failed'));
    const controller = new DiffTreeController(makeDeps(host, { load, logError }));

    await controller.show(1);

    expect(logError).toHaveBeenCalledWith(
      'karst: loading ticket changes for Source Control failed',
      expect.any(Error),
    );
    expect(host.warn).toHaveBeenCalledWith('load failed');
    expect(controller.roots().slice(1)).toEqual([]);
  });

  it('a failed show keeps the previously shown ticket and its rows', async () => {
    const host = createFakeHost();
    const views = [
      makeWorktreeChangesView({
        label: 'backend',
        unstaged: [makeChangedFileView({ changeId: '1', status: 'modified', path: 'src/a.ts' })],
      }),
    ];
    const load = vi
      .fn()
      .mockResolvedValueOnce({
        snapshot: makeSnapshot(views),
        worktrees: [makeSpec('/wt/backend', 'backend')],
      })
      .mockRejectedValueOnce(new Error('boom'));
    const controller = new DiffTreeController(makeDeps(host, { load }));

    await controller.show(7);
    const shownRoots = controller.roots();
    await controller.show(8);

    expect(controller.selectedTicket()).toBe(7);
    expect(controller.roots()[0]!.label).toBe('FEAT-7 — title');
    expect(controller.roots().slice(1).map((node) => node.id)).toEqual(['unstaged']);
    expect(controller.roots()).toBe(shownRoots);
  });

  it('a second show started before the first resolves discards the first result', async () => {
    let resolveFirst!: (value: { snapshot: TicketChangesSnapshot; worktrees: readonly WorktreeSpec[] }) => void;
    const firstPromise = new Promise<{ snapshot: TicketChangesSnapshot; worktrees: readonly WorktreeSpec[] }>(
      (resolve) => {
        resolveFirst = resolve;
      },
    );
    const views1 = [
      makeWorktreeChangesView({
        label: 'repo1',
        unstaged: [makeChangedFileView({ changeId: '1', status: 'modified', path: 'a.ts' })],
      }),
    ];
    const views2 = [
      makeWorktreeChangesView({
        label: 'repo2',
        staged: [makeChangedFileView({ changeId: '2', status: 'added', path: 'b.ts' })],
      }),
    ];
    const load = vi
      .fn()
      .mockReturnValueOnce(firstPromise)
      .mockResolvedValueOnce({ snapshot: makeSnapshot(views2), worktrees: [makeSpec('/wt/repo2', 'repo2')] });
    const controller = new DiffTreeController(makeDeps(createFakeHost(), { load }));

    const show1 = controller.show(1);
    const show2 = controller.show(2);
    resolveFirst({ snapshot: makeSnapshot(views1), worktrees: [makeSpec('/wt/repo1', 'repo1')] });
    await Promise.all([show1, show2]);

    expect(controller.selectedTicket()).toBe(2);
    expect(controller.roots().slice(1).map((node) => node.id)).toEqual(['staged']);
  });

  it('show for a ticket with no worktrees leaves the selector alone', async () => {
    const host = createFakeHost();
    const labelFor = vi.fn(() => 'FEAT-1 — empty');
    const load = vi.fn().mockResolvedValue({ snapshot: makeSnapshot([]), worktrees: [] });
    const controller = new DiffTreeController(makeDeps(host, { load, labelFor }));

    await controller.show(1);

    expect(controller.roots()).toHaveLength(1);
    expect(controller.roots()[0]!.label).toBe('FEAT-1 — empty');
  });

  it('refresh() before any show is a no-op', async () => {
    const load = vi.fn();
    const controller = new DiffTreeController(makeDeps(createFakeHost(), { load }));

    await controller.refresh();

    expect(load).not.toHaveBeenCalled();
  });

  it('a reveal rejection is routed through logError and does not escape show', async () => {
    const host = createFakeHost();
    vi.mocked(host.reveal).mockRejectedValue(new Error('view not resolved'));
    const logError = vi.fn();
    const views = [
      makeWorktreeChangesView({
        unstaged: [makeChangedFileView({ changeId: '1', status: 'modified', path: 'a.ts' })],
      }),
    ];
    const load = vi.fn().mockResolvedValue({ snapshot: makeSnapshot(views), worktrees: [makeSpec('/wt/repo')] });
    const controller = new DiffTreeController(makeDeps(host, { load, logError }));

    await expect(controller.show(1)).resolves.toBeUndefined();

    expect(logError).toHaveBeenCalledWith(
      'karst: revealing ticket changes failed',
      expect.any(Error),
    );
    expect(controller.roots()).toHaveLength(2);
  });

  it('openChange with a known id calls openDiff with the mapped target and resolved column', async () => {
    const host = createFakeHost();
    const target = makeTarget();
    const openDiff = vi.fn().mockResolvedValue(undefined);
    const views = [
      makeWorktreeChangesView({
        staged: [makeChangedFileView({ changeId: '1', status: 'added', path: 'file.ts' })],
      }),
    ];
    const load = vi.fn().mockResolvedValue({
      snapshot: makeSnapshot(views, new Map([['1', target]])),
      worktrees: [makeSpec('/wt/repo')],
    });
    const controller = new DiffTreeController(makeDeps(host, { load, openDiff }));

    await controller.show(1);
    await controller.openChange('1');

    expect(openDiff).toHaveBeenCalledWith(target, 2);
  });

  it('openChange with an unknown id warns and does not call openDiff', async () => {
    const host = createFakeHost();
    const openDiff = vi.fn();
    const controller = new DiffTreeController(makeDeps(host, { openDiff }));

    await controller.show(1);
    await controller.openChange('unknown');

    expect(host.warn).toHaveBeenCalledWith(
      'That change is no longer available. Reopen changes for this ticket.',
    );
    expect(openDiff).not.toHaveBeenCalled();
  });

  it('openFile with a known id opens the row absolutePath', async () => {
    const host = createFakeHost();
    const openFile = vi.fn();
    const views = [
      makeWorktreeChangesView({
        unstaged: [makeChangedFileView({ changeId: 'b', status: 'modified', path: 'src/b.ts' })],
      }),
    ];
    const load = vi.fn().mockResolvedValue({ snapshot: makeSnapshot(views), worktrees: [makeSpec('/wt/backend', 'backend')] });
    const controller = new DiffTreeController(makeDeps(host, { load, openFile }));

    await controller.show(1);
    controller.openFile('b');

    expect(openFile).toHaveBeenCalledWith('/wt/backend/src/b.ts');
  });

  it('discard asks confirmDiscard first and does nothing on a false', async () => {
    const host = createFakeHost();
    const confirmDiscard = vi.fn().mockResolvedValue(false);
    const discard = vi.fn().mockResolvedValue({ ok: true });
    const views = [
      makeWorktreeChangesView({
        unstaged: [makeChangedFileView({ changeId: 'b', status: 'modified', path: 'src/b.ts' })],
      }),
    ];
    const load = vi.fn().mockResolvedValue({ snapshot: makeSnapshot(views), worktrees: [makeSpec('/wt/backend', 'backend')] });
    const controller = new DiffTreeController(makeDeps(host, { load, confirmDiscard, discard }));

    await controller.show(1);
    await controller.discard('b');

    expect(confirmDiscard).toHaveBeenCalledWith('src/b.ts');
    expect(discard).not.toHaveBeenCalled();
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('a confirmed discard calls deps.discard and refreshes', async () => {
    const host = createFakeHost();
    const discard = vi.fn().mockResolvedValue({ ok: true });
    const views = [
      makeWorktreeChangesView({
        unstaged: [makeChangedFileView({ changeId: 'b', status: 'modified', path: 'src/b.ts' })],
      }),
    ];
    const load = vi.fn().mockResolvedValue({ snapshot: makeSnapshot(views), worktrees: [makeSpec('/wt/backend', 'backend')] });
    const controller = new DiffTreeController(makeDeps(host, { load, discard }));

    await controller.show(1);
    await controller.discard('b');

    expect(discard).toHaveBeenCalledWith('/wt/backend', 'src/b.ts', 'modified');
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('a failed discard warns and does not refresh', async () => {
    const host = createFakeHost();
    const discard = vi.fn().mockResolvedValue({ ok: false, error: 'locked' });
    const views = [
      makeWorktreeChangesView({
        unstaged: [makeChangedFileView({ changeId: 'b', status: 'modified', path: 'src/b.ts' })],
      }),
    ];
    const load = vi.fn().mockResolvedValue({ snapshot: makeSnapshot(views), worktrees: [makeSpec('/wt/backend', 'backend')] });
    const controller = new DiffTreeController(makeDeps(host, { load, discard }));

    await controller.show(1);
    await controller.discard('b');

    expect(host.warn).toHaveBeenCalledWith('Could not discard changes: locked');
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('unstage calls deps.unstage and refreshes', async () => {
    const host = createFakeHost();
    const unstage = vi.fn().mockResolvedValue({ ok: true });
    const views = [
      makeWorktreeChangesView({
        staged: [makeChangedFileView({ changeId: 'a', status: 'added', path: 'src/a.ts' })],
      }),
    ];
    const load = vi.fn().mockResolvedValue({ snapshot: makeSnapshot(views), worktrees: [makeSpec('/wt/backend', 'backend')] });
    const controller = new DiffTreeController(makeDeps(host, { load, unstage }));

    await controller.show(1);
    await controller.unstage('a');

    expect(unstage).toHaveBeenCalledWith('/wt/backend', 'src/a.ts');
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('a failed unstage warns and does not refresh', async () => {
    const host = createFakeHost();
    const unstage = vi.fn().mockResolvedValue({ ok: false, error: 'locked' });
    const views = [
      makeWorktreeChangesView({
        staged: [makeChangedFileView({ changeId: 'a', status: 'added', path: 'src/a.ts' })],
      }),
    ];
    const load = vi.fn().mockResolvedValue({ snapshot: makeSnapshot(views), worktrees: [makeSpec('/wt/backend', 'backend')] });
    const controller = new DiffTreeController(makeDeps(host, { load, unstage }));

    await controller.show(1);
    await controller.unstage('a');

    expect(host.warn).toHaveBeenCalledWith('Could not unstage file: locked');
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('dispose makes a later show a no-op', async () => {
    const host = createFakeHost();
    const load = vi.fn().mockResolvedValue({ snapshot: makeSnapshot([]), worktrees: [] });
    const controller = new DiffTreeController(makeDeps(host, { load }));

    await controller.show(1);
    controller.dispose();
    await controller.show(2);

    expect(load).toHaveBeenCalledTimes(1);
    expect(controller.roots()).toHaveLength(1);
  });

  it('logs a tree show line, a line per root node and a render summary', async () => {
    const host = createFakeHost();
    const debug = vi.fn();
    const views = [
      makeWorktreeChangesView({
        unstaged: [
          makeChangedFileView({ changeId: '1', status: 'modified', path: 'src/a.ts' }),
          makeChangedFileView({ changeId: '2', status: 'modified', path: 'src/b.ts' }),
        ],
      }),
    ];
    const load = vi.fn().mockResolvedValue({ snapshot: makeSnapshot(views), worktrees: [makeSpec('/wt/repo')] });
    const controller = new DiffTreeController(makeDeps(host, { load, debug }));

    await controller.show(1);

    const lines = debug.mock.calls.map((call) => call[0] as string);
    expect(lines[0]).toBe('[diffs] tree show ticket=1');
    expect(lines.some((line) => line.startsWith('[diffs] tree node id=unstaged kind=group children=2'))).toBe(true);
    expect(lines.some((line) => line.includes('tree rendered nodes=1 worktrees=1'))).toBe(true);
  });
});
