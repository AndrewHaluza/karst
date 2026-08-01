import { describe, expect, it, vi } from 'vitest';
import { makeWorktreeActions, type WorktreeActionHost } from './worktreeActions.js';

const fakeHost = (): WorktreeActionHost => ({
  createTerminal: vi.fn(() => ({ show: vi.fn() })),
  revealInExplorer: vi.fn().mockResolvedValue(undefined),
  expandExplorer: vi.fn().mockResolvedValue(undefined),
  writeClipboard: vi.fn().mockResolvedValue(undefined),
});

describe('makeWorktreeActions', () => {
  it('creates and reveals a terminal rooted at the worktree', () => {
    const host = fakeHost();
    const terminal = { show: vi.fn() };
    vi.mocked(host.createTerminal).mockReturnValue(terminal);

    makeWorktreeActions(host, vi.fn()).openWorktreeTerminal('/wt/a');

    expect(host.createTerminal).toHaveBeenCalledWith({
      name: 'Karst Worktree',
      cwd: '/wt/a',
    });
    expect(terminal.show).toHaveBeenCalledOnce();
  });

  it('reveals before expanding the Explorer node', async () => {
    const order: string[] = [];
    const host = fakeHost();
    vi.mocked(host.revealInExplorer).mockImplementation(async () => {
      order.push('reveal');
    });
    vi.mocked(host.expandExplorer).mockImplementation(async () => {
      order.push('expand');
    });

    makeWorktreeActions(host, vi.fn()).openWorktreeFolder('/wt/a');

    await vi.waitFor(() => expect(order).toEqual(['reveal', 'expand']));
    expect(host.revealInExplorer).toHaveBeenCalledWith('/wt/a');
  });

  it('copies the branch through the host clipboard', async () => {
    const host = fakeHost();

    makeWorktreeActions(host, vi.fn()).copyWorktreeBranch('karst/A');

    await vi.waitFor(() => expect(host.writeClipboard).toHaveBeenCalledWith('karst/A'));
  });

  it('reports rejected asynchronous effects', async () => {
    const error = new Error('clipboard unavailable');
    const host = fakeHost();
    const logError = vi.fn();
    vi.mocked(host.writeClipboard).mockRejectedValue(error);

    makeWorktreeActions(host, logError).copyWorktreeBranch('karst/A');

    await vi.waitFor(() =>
      expect(logError).toHaveBeenCalledWith('karst: dashboard worktree action failed', error),
    );
  });
});
