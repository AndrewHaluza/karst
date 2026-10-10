import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  deleteTicketOp,
  createFollowUpTicketOp,
  createSubtaskOp,
  detachSubtaskOp,
  type LifecycleOpsDeps,
} from './lifecycleOps.js';

vi.mock('../../store/tickets.js', () => ({
  getTicket: vi.fn().mockReturnValue({ id: 1, key: 'T-1', status: 'done' }),
  ticketLabel: vi.fn((_t: unknown, _tmpl?: string) => 'T-1: test ticket'),
}));
vi.mock('../../runtime/deleteTicket.js', () => ({
  deleteTicketPermanently: vi.fn().mockResolvedValue({ reapedServers: [], failedWorktrees: 0 }),
}));
vi.mock('../../workflow/stages/followUp.js', () => ({
  createFollowUpTicket: vi.fn().mockReturnValue({ id: 2, key: 'T-2' }),
  TicketNotDoneError: class TicketNotDoneError extends Error {
    constructor(ticketId: number, stageCurrent: string | null) {
      super(`ticket T${ticketId} is not done yet (stage: ${stageCurrent ?? 'none'})`);
      this.name = 'TicketNotDoneError';
    }
  },
}));
vi.mock('../../workflow/stages/subtask.js', () => ({
  createSubtask: vi.fn().mockReturnValue({ id: 3, key: 'S-1' }),
}));
vi.mock('../../workflow/detachSubtask.js', () => ({
  detachSubtask: vi.fn(),
  DetachSubtaskError: class DetachSubtaskError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'DetachSubtaskError';
    }
  },
}));
vi.mock('../../workflow/changeBaseRef.js', () => ({
  describeChangeBaseRef: vi.fn(() => 'rebased'),
}));

import { getTicket, ticketLabel } from '../../store/tickets.js';
import { deleteTicketPermanently } from '../../runtime/deleteTicket.js';
import { createFollowUpTicket, TicketNotDoneError } from '../../workflow/stages/followUp.js';
import { createSubtask } from '../../workflow/stages/subtask.js';
import { detachSubtask, DetachSubtaskError } from '../../workflow/detachSubtask.js';
import { describeChangeBaseRef } from '../../workflow/changeBaseRef.js';

function makeDeps(overrides: Partial<LifecycleOpsDeps> = {}): LifecycleOpsDeps {
  return {
    store: {} as LifecycleOpsDeps['store'],
    notify: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    log: { debug: vi.fn(), warn: vi.fn() },
    confirm: vi.fn().mockResolvedValue(true),
    deleteDeps: {
      closePanel: vi.fn(),
      reap: vi.fn().mockResolvedValue(undefined),
      allocator: { allocate: vi.fn(() => ({})), release: vi.fn() },
      graphBytesRoot: '/graph',
      artifactsRoot: '/artifacts',
    },
    openEdit: vi.fn(),
    refresh: vi.fn(),
    reloadManifest: vi.fn(),
    projectId: vi.fn().mockReturnValue(1),
    labelTemplate: vi.fn(),
    git: vi.fn().mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 }),
    gh: vi.fn().mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 }),
    manifest: vi.fn().mockReturnValue(undefined),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getTicket).mockReturnValue({ id: 1, key: 'T-1', status: 'done' } as never);
  vi.mocked(ticketLabel).mockReturnValue('T-1: test ticket');
  vi.mocked(createFollowUpTicket).mockReturnValue({ id: 2, key: 'T-2' } as never);
  vi.mocked(createSubtask).mockReturnValue({ id: 3, key: 'S-1' } as never);
  vi.mocked(describeChangeBaseRef).mockReturnValue('rebased');
});

// ---------------------------------------------------------------------------
// deleteTicketOp
// ---------------------------------------------------------------------------

describe('deleteTicketOp', () => {
  it('confirm declined does not delete', async () => {
    const d = makeDeps({ confirm: vi.fn().mockResolvedValue(false) });
    await deleteTicketOp(d, 1);
    expect(deleteTicketPermanently).not.toHaveBeenCalled();
    expect(d.refresh).not.toHaveBeenCalled();
  });

  it('confirm accepted calls delete', async () => {
    const d = makeDeps();
    await deleteTicketOp(d, 1);
    expect(deleteTicketPermanently).toHaveBeenCalledWith(d.store, 1, d.deleteDeps);
    expect(d.refresh).toHaveBeenCalled();
  });

  describe('artifact history keep/purge', () => {
    const artifacts = () => ({
      mirrorGraph: vi.fn().mockResolvedValue(undefined),
      sweepWorktree: vi.fn().mockResolvedValue(undefined),
      purge: vi.fn().mockResolvedValue(undefined),
    });

    it('keep (second prompt declined) wires the sweeps in and does not purge', async () => {
      const a = artifacts();
      const confirm = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
      const d = makeDeps({ artifacts: a, confirm });
      await deleteTicketOp(d, 1);
      expect(confirm).toHaveBeenCalledTimes(2);
      expect(deleteTicketPermanently).toHaveBeenCalledWith(d.store, 1, {
        ...d.deleteDeps,
        sweepTicket: a.mirrorGraph,
        sweepWorktree: a.sweepWorktree,
      });
      expect(a.purge).not.toHaveBeenCalled();
    });

    it('purge skips the sweeps and purges after the delete', async () => {
      const a = artifacts();
      const order: string[] = [];
      vi.mocked(deleteTicketPermanently).mockImplementationOnce(async () => {
        order.push('delete');
        return { reapedServers: [], failedWorktrees: 0 };
      });
      a.purge.mockImplementation(async () => void order.push('purge'));
      const d = makeDeps({ artifacts: a });
      await deleteTicketOp(d, 1);
      expect(deleteTicketPermanently).toHaveBeenCalledWith(d.store, 1, d.deleteDeps);
      expect(order).toEqual(['delete', 'purge']);
    });

    it('declining the delete never reaches the keep/purge prompt', async () => {
      const confirm = vi.fn().mockResolvedValue(false);
      await deleteTicketOp(makeDeps({ artifacts: artifacts(), confirm }), 1);
      expect(confirm).toHaveBeenCalledTimes(1);
    });
  });

  it('delete throwing logs warn, notifies error, and still refreshes', async () => {
    const d = makeDeps();
    vi.mocked(deleteTicketPermanently).mockRejectedValue(new Error('disk full'));
    await deleteTicketOp(d, 1);
    const expected =
      'Karst could not finish permanently deleting "T-1: test ticket". ' +
      'Attachment cleanup may be incomplete: Error: disk full';
    expect(d.log.warn).toHaveBeenCalledWith(expected);
    expect(d.notify.error).toHaveBeenCalledWith(expected);
    expect(d.refresh).toHaveBeenCalled();
  });

  it('confirmation message contains the ticket label', async () => {
    const d = makeDeps();
    await deleteTicketOp(d, 1);
    expect(d.confirm).toHaveBeenCalledWith(
      'Permanently delete "T-1: test ticket"? This cannot be undone.',
      'Delete',
    );
  });

  // A delete takes the `servers` rows with it, so this is the last moment a
  // server killed inside a removed worktree can be named. A kill that FAILED is
  // a live server serving a deleted tree, and must surface as a warning.
  it('reports a server killed inside a removed worktree', async () => {
    const d = makeDeps();
    vi.mocked(deleteTicketPermanently).mockResolvedValue({
      reapedServers: [
        {
          id: 7,
          repo: 'web',
          pid: 42,
          cwd: '/repo/.karst/worktrees/t-1',
          reason: 'worktree-removed',
          container: null,
          outcome: 'killed',
        },
      ],
      failedWorktrees: 0,
    });
    await deleteTicketOp(d, 1);
    expect(d.log.debug).toHaveBeenCalledWith(expect.stringContaining("stopped 'web'"));
    expect(d.notify.warn).not.toHaveBeenCalled();
  });

  it('warns when a server inside a removed worktree could not be killed', async () => {
    const d = makeDeps();
    vi.mocked(deleteTicketPermanently).mockResolvedValue({
      reapedServers: [
        {
          id: 8,
          repo: 'web',
          pid: 43,
          cwd: '/repo/.karst/worktrees/t-1',
          reason: 'worktree-removed',
          container: null,
          outcome: 'kill-failed',
        },
      ],
      failedWorktrees: 0,
    });
    await deleteTicketOp(d, 1);
    expect(d.notify.warn).toHaveBeenCalledWith(expect.stringContaining("could NOT stop 'web'"));
  });

  it('warns when a worktree folder could not be removed', async () => {
    const d = makeDeps();
    vi.mocked(deleteTicketPermanently).mockResolvedValue({
      reapedServers: [],
      failedWorktrees: 2,
    });
    await deleteTicketOp(d, 1);
    expect(d.notify.warn).toHaveBeenCalledWith(
      'Karst deleted "T-1: test ticket" but could not remove 2 worktree folder(s); they may remain on disk.',
    );
  });
});

// ---------------------------------------------------------------------------
// createFollowUpTicketOp
// ---------------------------------------------------------------------------

describe('createFollowUpTicketOp', () => {
  it('success refreshes, reloads manifest, opens edit, and shows info', async () => {
    const d = makeDeps();
    await createFollowUpTicketOp(d, 1);
    expect(createFollowUpTicket).toHaveBeenCalledWith(
      d.store,
      1,
      { projectId: 1 },
      expect.any(Function),
    );
    // The progress callback is wired to the injected debug seam.
    const onDebug = vi.mocked(createFollowUpTicket).mock.calls[0]![3] as (m: string) => void;
    onDebug('creating follow-up');
    expect(d.log.debug).toHaveBeenCalledWith('creating follow-up');
    expect(d.refresh).toHaveBeenCalled();
    expect(d.reloadManifest).toHaveBeenCalled();
    expect(d.openEdit).toHaveBeenCalledWith(2);
    expect(d.notify.info).toHaveBeenCalledWith('Created follow-up ticket T-2.');
  });

  it('TicketNotDoneError shows error message verbatim', async () => {
    const d = makeDeps();
    // The mock TicketNotDoneError constructor matches the real signature
    vi.mocked(createFollowUpTicket).mockImplementation(() => {
      throw new TicketNotDoneError(1, 'done');
    });
    await createFollowUpTicketOp(d, 1);
    expect(d.notify.error).toHaveBeenCalledWith('ticket T1 is not done yet (stage: done)');
    expect(d.refresh).not.toHaveBeenCalled();
    expect(d.openEdit).not.toHaveBeenCalled();
  });

  it('generic error prefixes message', async () => {
    const d = makeDeps();
    vi.mocked(createFollowUpTicket).mockImplementation(() => {
      throw new Error('db locked');
    });
    await createFollowUpTicketOp(d, 1);
    expect(d.notify.error).toHaveBeenCalledWith("Couldn't create a follow-up ticket: db locked");
  });

  it('non-Error throw uses String(err)', async () => {
    const d = makeDeps();
    vi.mocked(createFollowUpTicket).mockImplementation(() => {
      throw 'some string';
    });
    await createFollowUpTicketOp(d, 1);
    expect(d.notify.error).toHaveBeenCalledWith("Couldn't create a follow-up ticket: some string");
  });

  it('resolveManifest returning undefined still opens edit and shows info', async () => {
    const d = makeDeps({ reloadManifest: vi.fn() });
    await createFollowUpTicketOp(d, 1);
    expect(d.openEdit).toHaveBeenCalledWith(2);
    expect(d.notify.info).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// createSubtaskOp
// ---------------------------------------------------------------------------

describe('createSubtaskOp', () => {
  it('creates not-queued, wires the debug seam, and opens the edit form', async () => {
    const d = makeDeps();
    await createSubtaskOp(d, 5, {
      title: 'piece',
      description: 'the ask',
      blocking: true,
      repos: ['web'],
    });

    expect(createSubtask).toHaveBeenCalledWith(
      d.store,
      5,
      { title: 'piece', description: 'the ask', blocking: true, repos: ['web'], start: false, relationSource: 'user' },
      { projectId: 1 },
      expect.any(Function),
    );
    const onDebug = vi.mocked(createSubtask).mock.calls[0]![4] as (m: string) => void;
    onDebug('not queued');
    expect(d.log.debug).toHaveBeenCalledWith('not queued');
    expect(d.refresh).toHaveBeenCalled();
    expect(d.reloadManifest).toHaveBeenCalled();
    expect(d.openEdit).toHaveBeenCalledWith(3);
    expect(d.notify.info).toHaveBeenCalledWith('Created sub-task S-1.');
  });

  it('syncs the new child to the provider before refreshing, and not when creation fails', async () => {
    const order: string[] = [];
    const d = { ...makeDeps(), syncSubtask: vi.fn(async () => void order.push('sync')) };
    vi.mocked(d.refresh).mockImplementation(() => void order.push('refresh'));
    await createSubtaskOp(d, 5, { title: 'x' });
    expect(d.syncSubtask).toHaveBeenCalledWith(3);
    expect(order).toEqual(['sync', 'refresh']);

    vi.mocked(createSubtask).mockImplementationOnce(() => {
      throw new Error('nope');
    });
    await createSubtaskOp(d, 5, { title: 'y' });
    expect(d.syncSubtask).toHaveBeenCalledTimes(1);
  });

  it('passes an Error message through and does not continue', async () => {
    const d = makeDeps();
    vi.mocked(createSubtask).mockImplementation(() => {
      throw new Error('depth exceeded');
    });
    await createSubtaskOp(d, 5, { title: 'x' });
    expect(d.notify.error).toHaveBeenCalledWith('depth exceeded');
    expect(d.refresh).not.toHaveBeenCalled();
    expect(d.openEdit).not.toHaveBeenCalled();
  });

  it('wraps a non-Error throw', async () => {
    const d = makeDeps();
    vi.mocked(createSubtask).mockImplementation(() => {
      throw 'nope';
    });
    await createSubtaskOp(d, 5, { title: 'x' });
    expect(d.notify.error).toHaveBeenCalledWith("Couldn't create a sub-task: nope");
  });
});

// ---------------------------------------------------------------------------
// detachSubtaskOp
// ---------------------------------------------------------------------------

describe('detachSubtaskOp', () => {
  it('refuses when no manifest is loaded', async () => {
    const d = makeDeps();
    await detachSubtaskOp(d, 7);
    expect(d.notify.error).toHaveBeenCalledWith('No manifest is loaded — cannot detach sub-task.');
    expect(detachSubtask).not.toHaveBeenCalled();
    expect(d.refresh).not.toHaveBeenCalled();
  });

  it('detaches with no started worktrees, wires debug, and clears the parent', async () => {
    const manifest = { name: 'm' } as never;
    const d = makeDeps({ manifest: vi.fn().mockReturnValue(manifest) });
    vi.mocked(getTicket).mockReturnValue({ id: 7, key: 'S-9' } as never);
    vi.mocked(detachSubtask).mockResolvedValue({
      ok: true,
      reason: '',
      rebases: new Map(),
    } as never);

    await detachSubtaskOp(d, 7);

    expect(detachSubtask).toHaveBeenCalledWith({
      store: d.store,
      manifest,
      ticketId: 7,
      git: d.git,
      gh: d.gh,
      debug: expect.any(Function),
    });
    const onDebug = vi.mocked(detachSubtask).mock.calls[0]![0].debug as (m: string) => void;
    onDebug('detaching');
    expect(d.log.debug).toHaveBeenCalledWith('detaching');
    expect(d.refresh).toHaveBeenCalled();
    expect(d.reloadManifest).toHaveBeenCalled();
    expect(d.notify.info).toHaveBeenCalledWith(
      'Detached T7 · S-9 from its parent (no started worktrees to rebase).',
    );
  });

  it('names each repo rebase in the toast', async () => {
    const manifest = { name: 'm' } as never;
    const d = makeDeps({ manifest: vi.fn().mockReturnValue(manifest) });
    vi.mocked(getTicket).mockReturnValue({ id: 7, key: 'S-9' } as never);
    vi.mocked(detachSubtask).mockResolvedValue({
      ok: true,
      reason: '',
      rebases: new Map([
        ['/repo/web', { ok: true }],
        ['/repo/api', { ok: true }],
      ]),
    } as never);
    vi.mocked(describeChangeBaseRef).mockReturnValue('moved onto main');

    await detachSubtaskOp(d, 7);

    expect(describeChangeBaseRef).toHaveBeenCalledWith({ ok: true });
    expect(d.notify.info).toHaveBeenCalledWith(
      'Detached T7 · S-9 from its parent. /repo/web: moved onto main /repo/api: moved onto main',
    );
  });

  it('falls back to the numeric id when the ticket has no key', async () => {
    const manifest = { name: 'm' } as never;
    const d = makeDeps({ manifest: vi.fn().mockReturnValue(manifest) });
    vi.mocked(getTicket).mockReturnValue({ id: 7, key: null } as never);
    vi.mocked(detachSubtask).mockResolvedValue({
      ok: true,
      reason: '',
      rebases: new Map(),
    } as never);

    await detachSubtaskOp(d, 7);

    expect(d.notify.info).toHaveBeenCalledWith(
      'Detached T7 from its parent (no started worktrees to rebase).',
    );
  });

  it('passes a DetachSubtaskError message through unchanged', async () => {
    const manifest = { name: 'm' } as never;
    const d = makeDeps({ manifest: vi.fn().mockReturnValue(manifest) });
    vi.mocked(detachSubtask).mockRejectedValue(
      new DetachSubtaskError('cannot detach sub-task #7: it blocks its parent'),
    );

    await detachSubtaskOp(d, 7);

    expect(d.notify.error).toHaveBeenCalledWith(
      'cannot detach sub-task #7: it blocks its parent',
    );
    expect(d.refresh).not.toHaveBeenCalled();
  });

  it('wraps a non-DetachSubtaskError', async () => {
    const manifest = { name: 'm' } as never;
    const d = makeDeps({ manifest: vi.fn().mockReturnValue(manifest) });
    vi.mocked(detachSubtask).mockRejectedValue(new Error('git exploded'));

    await detachSubtaskOp(d, 7);

    expect(d.notify.error).toHaveBeenCalledWith("Couldn't detach the sub-task: git exploded");
    expect(d.refresh).not.toHaveBeenCalled();
  });

  it('reports a partial git failure by its reason and does not refresh', async () => {
    const manifest = { name: 'm' } as never;
    const d = makeDeps({ manifest: vi.fn().mockReturnValue(manifest) });
    vi.mocked(detachSubtask).mockResolvedValue({
      ok: false,
      reason: 'web failed: boom. Re-running detach is safe.',
      rebases: new Map(),
    } as never);

    await detachSubtaskOp(d, 7);

    expect(d.notify.error).toHaveBeenCalledWith(
      'Could not detach sub-task: web failed: boom. Re-running detach is safe.',
    );
    expect(d.refresh).not.toHaveBeenCalled();
    expect(d.notify.info).not.toHaveBeenCalled();
  });
});
