import { describe, it, expect, vi, beforeEach } from 'vitest';
import { deleteTicketOp, createFollowUpTicketOp, type LifecycleOpsDeps } from './lifecycleOps.js';

vi.mock('../../store/tickets.js', () => ({
  getTicket: vi.fn().mockReturnValue({ id: 1, key: 'T-1', status: 'done' }),
  ticketLabel: vi.fn((_t: unknown, _tmpl?: string) => 'T-1: test ticket'),
}));
vi.mock('../../runtime/deleteTicket.js', () => ({
  deleteTicketPermanently: vi.fn().mockResolvedValue([]),
}));
vi.mock('../../workflow/stages/followUp.js', () => ({
  createFollowUpTicket: vi.fn().mockReturnValue({ id: 2, key: 'T-2' }),
  TicketNotDoneError: class TicketNotDoneError extends Error {
    constructor(ticketId: number, stageCurrent: string | null) {
      super(`ticket #${ticketId} is not done yet (stage: ${stageCurrent ?? 'none'})`);
      this.name = 'TicketNotDoneError';
    }
  },
}));

import { getTicket, ticketLabel } from '../../store/tickets.js';
import { deleteTicketPermanently } from '../../runtime/deleteTicket.js';
import { createFollowUpTicket, TicketNotDoneError } from '../../workflow/stages/followUp.js';

function makeDeps(overrides: Partial<LifecycleOpsDeps> = {}): LifecycleOpsDeps {
  return {
    store: {} as LifecycleOpsDeps['store'],
    notify: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    log: { debug: vi.fn(), warn: vi.fn() },
    confirm: vi.fn().mockResolvedValue(true),
    deleteDeps: {
      closePanel: vi.fn(),
      reap: vi.fn().mockResolvedValue(undefined),
      graphBytesRoot: '/graph',
      artifactsRoot: '/artifacts',
      ports: { allocate: vi.fn().mockReturnValue({}), release: vi.fn() },
    },
    openEdit: vi.fn(),
    refresh: vi.fn(),
    reloadManifest: vi.fn(),
    projectId: vi.fn().mockReturnValue(1),
    labelTemplate: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getTicket).mockReturnValue({ id: 1, key: 'T-1', status: 'done' } as never);
  vi.mocked(ticketLabel).mockReturnValue('T-1: test ticket');
  vi.mocked(createFollowUpTicket).mockReturnValue({ id: 2, key: 'T-2' } as never);
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

  it('delete throwing logs warn, notifies error, and still refreshes', async () => {
    const d = makeDeps();
    vi.mocked(deleteTicketPermanently).mockRejectedValue(new Error('disk full'));
    await deleteTicketOp(d, 1);
    expect(d.log.warn).toHaveBeenCalled();
    expect(d.notify.error).toHaveBeenCalled();
    expect(d.refresh).toHaveBeenCalled();
  });

  it('names a reaped server and warns when the kill was refused', async () => {
    const d = makeDeps();
    vi.mocked(deleteTicketPermanently).mockResolvedValue([
      {
        id: 7,
        repo: 'frontend',
        pid: 4242,
        cwd: '/w/abc',
        reason: 'worktree-removed',
        container: null,
        outcome: 'kill-failed',
      },
    ]);
    await deleteTicketOp(d, 1);
    expect(d.log.debug).toHaveBeenCalledWith(expect.stringContaining("could NOT stop 'frontend'"));
    expect(d.notify.warn).toHaveBeenCalledWith(expect.stringContaining("could NOT stop 'frontend'"));
  });

  it('confirmation message contains the ticket label', async () => {
    const d = makeDeps();
    await deleteTicketOp(d, 1);
    expect(d.confirm).toHaveBeenCalledWith(
      'Permanently delete "T-1: test ticket"? This cannot be undone.',
      'Delete',
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
    expect(d.notify.error).toHaveBeenCalledWith('ticket #1 is not done yet (stage: done)');
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
