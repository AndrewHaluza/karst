import { describe, it, expect, vi } from 'vitest';
import { openStore } from '../../store/db.js';
import { createTicket, getTicket } from '../../store/tickets.js';
import { createTicketFlow } from '../../workflow/stages/create.js';
import { transition } from '../../workflow/machine.js';
import { formatTicketRef } from '../../model/entityId.js';
import { closeTicketOp, reopenTicketOp, describeLeft, type CloseOpsDeps } from './closeOps.js';

function setup(answer: { reason: string; ref?: string } | null = { reason: 'Sam did it' }) {
  const store = openStore(':memory:');
  const id = createTicketFlow(store, { key: 'T-1', title: 't' }).id;
  transition(store, id, 'scope', { kind: 'passed' });
  const calls: string[] = [];
  const notify = {
    info: vi.fn((m: string) => void calls.push(`info:${m}`)),
    warn: vi.fn((m: string) => void calls.push(`warn:${m}`)),
    error: vi.fn(async (m: string) => void calls.push(`error:${m}`)),
  };
  const deps: CloseOpsDeps = {
    store,
    notify,
    log: { error: vi.fn() },
    askReason: vi.fn(async () => answer ?? undefined),
    stopWork: vi.fn((t: number) => void calls.push(`stop:${t}`)),
    refresh: vi.fn(() => void calls.push('refresh')),
  };
  return { store, id, deps, notify, calls };
}

describe('closeTicketOp', () => {
  it('closes the ticket, stops its live work, refreshes and says so', async () => {
    const { store, id, deps, notify } = setup({ reason: 'Sam did it', ref: 'CU-9' });
    await closeTicketOp(deps, id);
    expect(getTicket(store, id).stageCurrent).toBe('closed');
    expect(getTicket(store, id).stages.find((s) => s.stageKey === 'closed')?.verdict).toBe('Sam did it (CU-9)');
    expect(deps.stopWork).toHaveBeenCalledWith(id);
    expect(deps.refresh).toHaveBeenCalledWith(id);
    expect(deps.refresh).toHaveBeenCalledTimes(1);
    expect(notify.info).toHaveBeenCalledWith(
      `Karst: closed ${formatTicketRef(id, 'T-1')} — resolved outside karst, nothing was verified.`,
    );
  });

  it('does nothing when the user cancels the prompt', async () => {
    const { store, id, deps, notify } = setup(null);
    await closeTicketOp(deps, id);
    expect(getTicket(store, id).stageCurrent).toBe('impl');
    expect(deps.stopWork).not.toHaveBeenCalled();
    expect(deps.refresh).not.toHaveBeenCalled();
    expect(notify.info).not.toHaveBeenCalled();
  });

  it('reports an open sub-task as an error and stops nothing', async () => {
    const store = openStore(':memory:');
    const parent = createTicket(store, { key: 'P', title: 'p' });
    createTicket(store, { key: 'C', title: 'c', subtaskParentId: parent.id });
    const error = vi.fn(async () => {});
    const stopWork = vi.fn();
    const refresh = vi.fn();
    await closeTicketOp(
      {
        store,
        notify: { info: vi.fn(), warn: vi.fn(), error },
        log: { error: vi.fn() },
        askReason: async () => ({ reason: 'r' }),
        stopWork,
        refresh,
      },
      parent.id,
    );
    expect(error).toHaveBeenCalledWith(expect.stringContaining('open sub-tasks (C)'));
    expect(stopWork).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
    expect(getTicket(store, parent.id).stageCurrent).toBe('scope');
  });

  it('still refreshes and reports when stopping live work throws', async () => {
    const { id, deps, notify } = setup();
    (deps.stopWork as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error('boom');
    });
    await closeTicketOp(deps, id);
    expect(deps.log.error).toHaveBeenCalledWith(expect.stringContaining('stopping'), expect.any(Error));
    expect(deps.refresh).toHaveBeenCalledTimes(1);
    expect(notify.info).toHaveBeenCalled();
  });

  it('appends what was left behind to the message', async () => {
    const { store, id, deps, notify } = setup();
    store.db.prepare("INSERT INTO prs (ticket_id, repo, number, status) VALUES (?, 'a', 1, 'open')").run(id);
    await closeTicketOp(deps, id);
    expect(notify.info).toHaveBeenCalledWith(
      `Karst: closed ${formatTicketRef(id, 'T-1')} — resolved outside karst, nothing was verified. Left as is: 1 open PR.`,
    );
  });
});

describe('describeLeft', () => {
  it('is empty when nothing is left', () => {
    expect(describeLeft({ openPrs: 0, worktrees: 0, runningServers: 0 })).toBe('');
  });
  it('pluralises each part and joins the non-zero ones', () => {
    expect(describeLeft({ openPrs: 2, worktrees: 1, runningServers: 3 })).toBe(
      ' Left as is: 2 open PRs, 1 worktree, 3 running servers.',
    );
    expect(describeLeft({ openPrs: 0, worktrees: 1, runningServers: 0 })).toBe(' Left as is: 1 worktree.');
  });
});

describe('reopenTicketOp', () => {
  it('reopens a closed ticket and refreshes', async () => {
    const { store, id, deps, notify } = setup();
    await closeTicketOp(deps, id);
    await reopenTicketOp(deps, id);
    expect(getTicket(store, id).stageCurrent).toBe('impl');
    expect(notify.info).toHaveBeenLastCalledWith(
      `Karst: reopened ${formatTicketRef(id, 'T-1')} — back at implementation.`,
    );
    expect(deps.refresh).toHaveBeenNthCalledWith(2, id);
    expect(deps.refresh).toHaveBeenCalledTimes(2);
  });

  it('reports a ticket that is not closed', async () => {
    const { id, deps, notify } = setup();
    await reopenTicketOp(deps, id);
    expect(notify.error).toHaveBeenCalledWith(expect.stringContaining('not closed'));
    expect(deps.refresh).not.toHaveBeenCalled();
  });
});
