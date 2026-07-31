import { describe, expect, it, vi } from 'vitest';
import type { DiffTarget, InspectedFile, InspectedWorktree, WorktreeSpec } from './git.js';
import { buildTicketChangesSnapshot } from './snapshot.js';

const firstSpec: WorktreeSpec = {
  label: 'API',
  path: '/worktrees/api',
  branch: 'ticket/api',
  baseRef: 'main',
};

const secondSpec: WorktreeSpec = {
  label: 'Web',
  path: '/worktrees/web',
  branch: null,
  baseRef: 'origin/main',
};

function target(path: string): DiffTarget {
  return {
    repoLabel: 'Repository',
    groupLabel: 'Changes',
    displayPath: path,
    left: { kind: 'empty', label: 'Empty' },
    right: { kind: 'working', path: `/worktrees/repository/${path}`, label: 'Working Tree' },
    binaryCheck: { kind: 'untracked', path },
  };
}

function file(path: string, status: InspectedFile['status'] = 'modified'): InspectedFile {
  return { status, path, oldPath: null, target: target(path) };
}

function inspected(
  spec: WorktreeSpec,
  options: {
    commits?: InspectedWorktree['commits'];
    staged?: InspectedFile[];
    unstaged?: InspectedFile[];
    untracked?: InspectedFile[];
  } = {},
): InspectedWorktree {
  return {
    spec,
    commits: options.commits ?? [],
    staged: options.staged ?? [],
    unstaged: options.unstaged ?? [],
    untracked: options.untracked ?? [],
  };
}

describe('buildTicketChangesSnapshot', () => {
  it('combines every physical worktree and reports commits separately from pending entries', async () => {
    const first = inspected(firstSpec, {
      commits: [{
        hash: 'abcdef123456',
        shortHash: 'abcdef1',
        subject: 'Add endpoint',
        author: 'Ada',
        authoredAt: '2026-07-30T10:00:00Z',
        files: [file('src/api.ts')],
      }],
      staged: [file('src/staged.ts')],
      unstaged: [file('src/unstaged.ts')],
    });
    const second = inspected(secondSpec, { untracked: [file('src/new.ts', 'added')] });

    const snapshot = await buildTicketChangesSnapshot(
      42,
      [firstSpec, secondSpec],
      async (spec) => (spec === firstSpec ? first : second),
      () => 'generation-a',
    );

    expect(snapshot.state).toEqual({
      ticketId: 42,
      worktreeCount: 2,
      commitCount: 1,
      pendingCount: 3,
      worktrees: [
        {
          label: 'API',
          branch: 'ticket/api',
          baseRef: 'main',
          commits: [{
            hash: 'abcdef123456',
            shortHash: 'abcdef1',
            subject: 'Add endpoint',
            author: 'Ada',
            authoredAt: '2026-07-30T10:00:00Z',
            files: [{ changeId: 'generation-a:1', status: 'modified', path: 'src/api.ts', oldPath: null }],
          }],
          staged: [{ changeId: 'generation-a:2', status: 'modified', path: 'src/staged.ts', oldPath: null }],
          unstaged: [{ changeId: 'generation-a:3', status: 'modified', path: 'src/unstaged.ts', oldPath: null }],
          untracked: [],
          error: null,
        },
        {
          label: 'Web',
          branch: null,
          baseRef: 'origin/main',
          commits: [],
          staged: [],
          unstaged: [],
          untracked: [{ changeId: 'generation-a:4', status: 'added', path: 'src/new.ts', oldPath: null }],
          error: null,
        },
      ],
    });
  });

  it('keeps a failed worktree as an inline error while successful worktrees remain', async () => {
    const successful = inspected(firstSpec, { staged: [file('src/kept.ts')] });

    const snapshot = await buildTicketChangesSnapshot(
      7,
      [firstSpec, secondSpec],
      async (spec) => {
        if (spec === secondSpec) throw new Error('Git inspection failed');
        return successful;
      },
      () => 'generation-b',
    );

    expect(snapshot.state).toMatchObject({ worktreeCount: 2, commitCount: 0, pendingCount: 1 });
    expect(snapshot.state.worktrees[0]).toMatchObject({ label: 'API', staged: [{ path: 'src/kept.ts' }], error: null });
    expect(snapshot.state.worktrees[1]).toEqual({
      label: 'Web',
      branch: null,
      baseRef: 'origin/main',
      commits: [],
      staged: [],
      unstaged: [],
      untracked: [],
      error: 'Git inspection failed',
    });
  });

  it('maps every actionable row to its trusted DiffTarget', async () => {
    const committed = file('src/committed.ts');
    const staged = file('src/staged.ts');
    const unstaged = file('src/unstaged.ts');
    const untracked = file('src/untracked.ts', 'added');
    const result = inspected(firstSpec, {
      commits: [{
        hash: 'abcdef123456', shortHash: 'abcdef1', subject: 'Commit', author: 'Ada', authoredAt: 'now', files: [committed],
      }],
      staged: [staged],
      unstaged: [unstaged],
      untracked: [untracked],
    });

    const snapshot = await buildTicketChangesSnapshot(4, [firstSpec], async () => result, () => 'generation-c');
    const changeIds = [
      snapshot.state.worktrees[0]!.commits[0]!.files[0]!.changeId,
      snapshot.state.worktrees[0]!.staged[0]!.changeId,
      snapshot.state.worktrees[0]!.unstaged[0]!.changeId,
      snapshot.state.worktrees[0]!.untracked[0]!.changeId,
    ];

    expect(snapshot.targets.get(changeIds[0]!)).toBe(committed.target);
    expect(snapshot.targets.get(changeIds[1]!)).toBe(staged.target);
    expect(snapshot.targets.get(changeIds[2]!)).toBe(unstaged.target);
    expect(snapshot.targets.get(changeIds[3]!)).toBe(untracked.target);
  });

  it('never reuses a change id across snapshot generations', async () => {
    const result = inspected(firstSpec, { staged: [file('src/changed.ts')] });
    const first = await buildTicketChangesSnapshot(1, [firstSpec], async () => result, () => 'first-generation');
    const second = await buildTicketChangesSnapshot(1, [firstSpec], async () => result, () => 'second-generation');

    expect(first.state.worktrees[0]!.staged[0]!.changeId).toBe('first-generation:1');
    expect(second.state.worktrees[0]!.staged[0]!.changeId).toBe('second-generation:1');
    expect(second.targets.has(first.state.worktrees[0]!.staged[0]!.changeId)).toBe(false);
  });

  it('propagates cancellation instead of rendering it as a repository error', async () => {
    const controller = new AbortController();
    controller.abort();
    const inspect = vi.fn(async () => inspected(firstSpec));

    const pending = buildTicketChangesSnapshot(
      1,
      [firstSpec],
      inspect,
      () => 'cancelled-generation',
      controller.signal,
    );

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(inspect).not.toHaveBeenCalled();
  });
});
