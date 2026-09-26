import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  archiveTicketOp,
  unarchiveTicketOp,
  archiveInactiveWorktreesOp,
  type ArchiveOpsDeps,
  type ArchiveInactiveDeps,
} from './archiveOps.js';
import type { Notify } from './notify.js';

// Mock the directly-imported modules
vi.mock('../../runtime/archiveBulk.js', () => ({
  archiveInactiveWorktrees: vi.fn().mockResolvedValue({ archived: 0, skipped: 0, failed: 0, reapedServers: [] }),
}));
vi.mock('../../store/tickets.js', () => ({
  archiveTicket: vi.fn(),
  unarchiveTicket: vi.fn(),
}));
vi.mock('../../store/dashboard.js', () => ({
  listWorktreesByTicket: vi.fn().mockReturnValue([]),
}));
vi.mock('../../store/worktreeArchives.js', () => ({
  listArchives: vi.fn().mockReturnValue([]),
}));
vi.mock('../../runtime/archive.js', () => ({
  archiveWorktree: vi.fn().mockResolvedValue({ reapedServers: [] }),
  restoreWorktree: vi.fn().mockResolvedValue({ outcome: 'restored' }),
}));
vi.mock('../../resolver/allocator.js', () => ({
  makePortAllocator: vi.fn().mockReturnValue({}),
}));
vi.mock('../../runtime/worktreeServers.js', () => ({
  describeReap: vi.fn((s: { path: string }) => `reaped ${s.path}`),
}));
vi.mock('../../extension/manifestResolve.js', () => ({
  emptyManifest: vi.fn().mockReturnValue({ closeDoneTerminalsWithTicket: false }),
}));

import { archiveTicket, unarchiveTicket } from '../../store/tickets.js';
import { listWorktreesByTicket } from '../../store/dashboard.js';
import { listArchives } from '../../store/worktreeArchives.js';
import { archiveWorktree, restoreWorktree } from '../../runtime/archive.js';
import { describeReap } from '../../runtime/worktreeServers.js';
import { archiveInactiveWorktrees } from '../../runtime/archiveBulk.js';

function makeNotify(): Notify {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function makeDeps(overrides: Partial<ArchiveOpsDeps> = {}): ArchiveOpsDeps {
  return {
    store: {} as ArchiveOpsDeps['store'],
    git: {} as ArchiveOpsDeps['git'],
    notify: makeNotify(),
    log: { info: vi.fn(), error: vi.fn() },
    appendLine: vi.fn(),
    closeDoneTerminals: vi.fn().mockReturnValue(0),
    manifest: vi.fn().mockReturnValue({ closeDoneTerminalsWithTicket: false, portRange: {} }),
    refresh: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(listWorktreesByTicket).mockReturnValue([]);
  vi.mocked(listArchives).mockReturnValue([]);
  vi.mocked(archiveWorktree).mockResolvedValue({ reapedServers: [] } as never);
  vi.mocked(restoreWorktree).mockResolvedValue({ outcome: 'restored' } as never);
  vi.mocked(archiveInactiveWorktrees).mockResolvedValue({
    archived: 0,
    skipped: 0,
    failed: 0,
    reapedServers: [],
  } as never);
});

// ---------------------------------------------------------------------------
// archiveTicketOp
// ---------------------------------------------------------------------------

describe('archiveTicketOp', () => {
  it('archives with no worktrees', async () => {
    const d = makeDeps();
    await archiveTicketOp(d, 1);
    expect(archiveTicket).toHaveBeenCalledWith(d.store, 1);
    expect(d.refresh).toHaveBeenCalledOnce();
    expect(archiveWorktree).not.toHaveBeenCalled();
  });

  it('archives with two worktrees', async () => {
    const d = makeDeps();
    vi.mocked(listWorktreesByTicket).mockReturnValue([
      { repo: '/r1', path: '/r1/w1', branch: 'b1', baseRef: null },
      { repo: '/r2', path: '/r2/w2', branch: 'b2', baseRef: 'base' },
    ] as never);
    await archiveTicketOp(d, 1);
    expect(archiveWorktree).toHaveBeenCalledTimes(2);
    expect(archiveWorktree).toHaveBeenNthCalledWith(1, d.git, d.store, {}, {
      ticketId: 1,
      repoPath: '/r1',
      path: '/r1/w1',
      branch: 'b1',
      baseRef: 'b1',
    });
    expect(archiveWorktree).toHaveBeenNthCalledWith(2, d.git, d.store, {}, {
      ticketId: 1,
      repoPath: '/r2',
      path: '/r2/w2',
      branch: 'b2',
      baseRef: 'base',
    });
  });

  it('skips a worktree with no branch', async () => {
    const d = makeDeps();
    vi.mocked(listWorktreesByTicket).mockReturnValue([
      { repo: '/r1', path: '/r1/w1', branch: null, baseRef: null },
    ] as never);
    await archiveTicketOp(d, 1);
    expect(archiveWorktree).not.toHaveBeenCalled();
  });

  it('continues after one worktree throws', async () => {
    const d = makeDeps();
    vi.mocked(listWorktreesByTicket).mockReturnValue([
      { repo: '/r1', path: '/r1/w1', branch: 'b1', baseRef: null },
      { repo: '/r2', path: '/r2/w2', branch: 'b2', baseRef: null },
    ] as never);
    vi.mocked(archiveWorktree)
      .mockRejectedValueOnce(new Error('fail1'))
      .mockResolvedValueOnce({ reapedServers: [] } as never);
    await archiveTicketOp(d, 1);
    expect(archiveWorktree).toHaveBeenCalledTimes(2);
    expect(d.appendLine).toHaveBeenCalledWith('archive worktree failed for /r1/w1: Error: fail1');
    expect(d.notify.warn).toHaveBeenCalledWith('Worktree not archived: Error: fail1');
  });

  it('calls closeDoneTerminals when setting is true', async () => {
    const d = makeDeps({
      manifest: vi.fn().mockReturnValue({ closeDoneTerminalsWithTicket: true, portRange: {} }),
      closeDoneTerminals: vi.fn().mockReturnValue(2),
    });
    await archiveTicketOp(d, 1);
    expect(d.closeDoneTerminals).toHaveBeenCalledWith(1);
    expect(d.log.info).toHaveBeenCalledWith('karst: closed 2 done terminal(s) with ticket 1');
  });

  it('does not call closeDoneTerminals when setting is false', async () => {
    const d = makeDeps({
      manifest: vi.fn().mockReturnValue({ closeDoneTerminalsWithTicket: false, portRange: {} }),
    });
    await archiveTicketOp(d, 1);
    expect(d.closeDoneTerminals).not.toHaveBeenCalled();
  });

  it('closeDoneTerminals throwing does not fail archive', async () => {
    const d = makeDeps({
      manifest: vi.fn().mockReturnValue({ closeDoneTerminalsWithTicket: true, portRange: {} }),
      closeDoneTerminals: vi.fn().mockImplementation(() => { throw new Error('term fail'); }),
    });
    await archiveTicketOp(d, 1);
    expect(d.log.error).toHaveBeenCalled();
    expect(d.refresh).toHaveBeenCalled();
  });

  it('closeDoneTerminals returning 0 does not log', async () => {
    const d = makeDeps({
      manifest: vi.fn().mockReturnValue({ closeDoneTerminalsWithTicket: true, portRange: {} }),
      closeDoneTerminals: vi.fn().mockReturnValue(0),
    });
    await archiveTicketOp(d, 1);
    expect(d.log.info).not.toHaveBeenCalled();
  });

  it('kill-failed outcome fires notify.warn', async () => {
    const d = makeDeps();
    vi.mocked(listWorktreesByTicket).mockReturnValue([
      { repo: '/r1', path: '/r1/w1', branch: 'b1', baseRef: null },
    ] as never);
    vi.mocked(archiveWorktree).mockResolvedValue({
      reapedServers: [{ outcome: 'kill-failed', path: '/r1/w1', pid: 123 }],
    } as never);
    await archiveTicketOp(d, 1);
    expect(d.notify.warn).toHaveBeenCalled();
  });

  it('a reap that succeeded is logged but does not warn', async () => {
    const d = makeDeps();
    vi.mocked(listWorktreesByTicket).mockReturnValue([
      { repo: '/r1', path: '/r1/w1', branch: 'b1', baseRef: null },
    ] as never);
    vi.mocked(archiveWorktree).mockResolvedValue({
      reapedServers: [{ outcome: 'killed', path: '/r1/w1', pid: 123 }],
    } as never);
    await archiveTicketOp(d, 1);
    expect(d.log.info).toHaveBeenCalledWith('reaped /r1/w1');
    expect(d.notify.warn).not.toHaveBeenCalled();
  });

  it('manifest undefined skips worktree loop but still refreshes', async () => {
    const d = makeDeps({ manifest: vi.fn().mockReturnValue(undefined) });
    await archiveTicketOp(d, 1);
    expect(listWorktreesByTicket).not.toHaveBeenCalled();
    expect(d.refresh).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// archiveInactiveWorktreesOp
// ---------------------------------------------------------------------------

function makeArchiveInactiveDeps(overrides: Partial<ArchiveInactiveDeps> = {}): ArchiveInactiveDeps {
  return {
    store: {} as ArchiveInactiveDeps['store'],
    git: {} as ArchiveInactiveDeps['git'],
    manifest: vi.fn().mockReturnValue({ portRange: {} }),
    projectId: vi.fn().mockReturnValue(7),
    notify: makeNotify(),
    log: { info: vi.fn() },
    refresh: vi.fn(),
    ...overrides,
  };
}

describe('archiveInactiveWorktreesOp', () => {
  it('refuses when no manifest is loaded', async () => {
    const d = makeArchiveInactiveDeps({ manifest: vi.fn().mockReturnValue(undefined) });
    await archiveInactiveWorktreesOp(d);
    expect(d.notify.warn).toHaveBeenCalledWith('Karst: no manifest loaded.');
    expect(archiveInactiveWorktrees).not.toHaveBeenCalled();
    expect(d.refresh).not.toHaveBeenCalled();
  });

  it('refuses an unbound project instead of degrading to all projects', async () => {
    const d = makeArchiveInactiveDeps({ projectId: vi.fn().mockReturnValue(undefined) });
    await archiveInactiveWorktreesOp(d);
    expect(d.notify.warn).toHaveBeenCalledWith(
      'Karst: no project bound — refusing to archive inactive worktrees.',
    );
    expect(archiveInactiveWorktrees).not.toHaveBeenCalled();
    expect(d.refresh).not.toHaveBeenCalled();
  });

  it('archives with the bound project id and reports the summary', async () => {
    const d = makeArchiveInactiveDeps();
    vi.mocked(archiveInactiveWorktrees).mockResolvedValue({
      archived: 3,
      skipped: 1,
      failed: 0,
      reapedServers: [{ outcome: 'killed', path: '/w', pid: 9 }],
    } as never);
    await archiveInactiveWorktreesOp(d);
    expect(archiveInactiveWorktrees).toHaveBeenCalledWith(d.git, d.store, {}, { projectId: 7 });
    expect(d.log.info).toHaveBeenCalledWith('reaped /w');
    expect(d.notify.info).toHaveBeenCalledWith(
      'Karst: archived 3 worktree(s), skipped 1, failed 0, stopped 1 running server(s).',
    );
    expect(d.notify.warn).not.toHaveBeenCalled();
    expect(d.refresh).toHaveBeenCalledOnce();
  });

  it('warns once about servers that could not be stopped', async () => {
    const d = makeArchiveInactiveDeps();
    vi.mocked(archiveInactiveWorktrees).mockResolvedValue({
      archived: 1,
      skipped: 0,
      failed: 0,
      reapedServers: [
        { outcome: 'kill-failed', path: '/a', repo: 'r1', pid: 11 },
        { outcome: 'kill-failed', path: '/b', repo: 'r2', pid: null },
      ],
    } as never);
    await archiveInactiveWorktreesOp(d);
    expect(d.notify.warn).toHaveBeenCalledWith(
      "Karst: could not stop 2 server(s) still running in archived worktrees — 'r1' (pid 11), 'r2' (pid unknown).",
    );
  });
});

// ---------------------------------------------------------------------------
// unarchiveTicketOp
// ---------------------------------------------------------------------------

describe('unarchiveTicketOp', () => {
  it('unarchive with skipped outcome fires warn', async () => {
    const d = makeDeps();
    vi.mocked(listArchives).mockReturnValue([
      { id: 1, ticketId: 1, repo: '/r', path: '/w1', branch: 'b', baseRef: null, archiveRef: 'ar', method: 'manual', archivedAt: '' },
    ] as never);
    vi.mocked(restoreWorktree).mockResolvedValue({ outcome: 'skipped', reason: 'branch exists' } as never);
    await unarchiveTicketOp(d, 1);
    expect(restoreWorktree).toHaveBeenCalledWith(d.git, d.store, {
      ticketId: 1,
      path: '/w1',
    });
    expect(d.notify.warn).toHaveBeenCalledWith('Worktree not restored: branch exists');
    expect(unarchiveTicket).toHaveBeenCalledWith(d.store, 1);
    expect(d.refresh).toHaveBeenCalled();
  });

  it('skipped with no reason uses unknown reason', async () => {
    const d = makeDeps();
    vi.mocked(listArchives).mockReturnValue([
      { id: 1, ticketId: 1, repo: '/r', path: '/w1', branch: 'b', baseRef: null, archiveRef: 'ar', method: 'manual', archivedAt: '' },
    ] as never);
    vi.mocked(restoreWorktree).mockResolvedValue({ outcome: 'skipped', reason: undefined } as never);
    await unarchiveTicketOp(d, 1);
    expect(d.notify.warn).toHaveBeenCalledWith('Worktree not restored: unknown reason');
  });

  it('restoreWorktree throwing does not stop unarchive', async () => {
    const d = makeDeps();
    vi.mocked(listArchives).mockReturnValue([
      { id: 1, ticketId: 1, repo: '/r', path: '/w1', branch: 'b', baseRef: null, archiveRef: 'ar', method: 'manual', archivedAt: '' },
    ] as never);
    vi.mocked(restoreWorktree).mockRejectedValue(new Error('git fail'));
    await unarchiveTicketOp(d, 1);
    expect(d.appendLine).toHaveBeenCalledWith('restore worktree failed for /w1: Error: git fail');
    expect(d.notify.warn).toHaveBeenCalledWith('Worktree not restored: Error: git fail');
    expect(unarchiveTicket).toHaveBeenCalled();
    expect(d.refresh).toHaveBeenCalled();
  });

  it('a restored worktree does not warn', async () => {
    const d = makeDeps();
    vi.mocked(listArchives).mockReturnValue([
      { id: 1, ticketId: 1, repo: '/r', path: '/w1', branch: 'b', baseRef: null, archiveRef: 'ar', method: 'manual', archivedAt: '' },
    ] as never);
    vi.mocked(restoreWorktree).mockResolvedValue({ outcome: 'restored' } as never);
    await unarchiveTicketOp(d, 1);
    expect(restoreWorktree).toHaveBeenCalledOnce();
    expect(d.notify.warn).not.toHaveBeenCalled();
    expect(unarchiveTicket).toHaveBeenCalledWith(d.store, 1);
  });
});
