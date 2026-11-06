import { describe, it, expect, vi, beforeEach } from 'vitest';

const m = vi.hoisted(() => ({
  hint: vi.fn(),
  cont: vi.fn(),
  buildActionDeps: vi.fn(),
  hostFromVscode: vi.fn(),
  registerStallCommands: vi.fn(),
}));
vi.mock('vscode', () => ({ tag: 'vscode' }));
vi.mock('./ops/reviewStallActions.js', () => ({ redesignHintAction: m.hint, continueAnywayAction: m.cont }));
vi.mock('./ops/reviewStallHost.js', () => ({
  buildActionDeps: m.buildActionDeps,
  hostFromVscode: m.hostFromVscode.mockReturnValue({ tag: 'host' }),
  registerStallCommands: m.registerStallCommands,
}));

import { reviewStallBinding, registerReviewStallCommands } from './reviewStallBinding.js';

describe('reviewStallBinding', () => {
  const deps = {
    store: {} as never,
    ticketId: 3,
    afterServerChange: vi.fn(),
    logError: vi.fn(),
    debug: vi.fn(),
    drive: vi.fn(),
    editTicket: vi.fn(),
  };
  beforeEach(() => {
    m.hint.mockClear();
    m.cont.mockClear();
    m.buildActionDeps.mockReset().mockReturnValue({ built: true });
  });

  it('builds the host from vscode once at load', () => {
    expect(m.hostFromVscode).toHaveBeenCalledWith({ tag: 'vscode' });
  });

  it('runs the hint and continue actions on freshly built deps, without editTicket', () => {
    m.hint.mockReturnValue('h');
    m.cont.mockReturnValue('c');
    const b = reviewStallBinding(deps);
    expect(b.reviewStallHint()).toBe('h');
    expect(b.reviewStallContinue()).toBe('c');
    expect(m.hint).toHaveBeenCalledWith({ built: true });
    expect(m.cont).toHaveBeenCalledWith({ built: true });
    const [host, rest] = m.buildActionDeps.mock.calls[0]!;
    expect(host).toEqual({ tag: 'host' });
    expect(rest).not.toHaveProperty('editTicket');
    expect(rest).toMatchObject({ ticketId: 3, drive: deps.drive });
  });

  it('rescope is the editTicket callback', () => {
    expect(reviewStallBinding(deps).reviewStallRescope).toBe(deps.editTicket);
  });

  it('registers the stall commands, dispatching each pick to the binding', () => {
    m.registerStallCommands.mockReturnValue(['d']);
    const base = { store: {} as never, afterServerChange: vi.fn(), logError: vi.fn(), debug: vi.fn(), drive: vi.fn() };
    expect(registerReviewStallCommands(base as never)).toEqual(['d']);
    const [host, passed, run] = m.registerStallCommands.mock.calls[0]!;
    expect(host).toEqual({ tag: 'host' });
    expect(passed).toBe(base);
    m.hint.mockReturnValue('hinted');
    expect(run('reviewStallHint', { ...deps })).toBe('hinted');
    run('reviewStallRescope', { ...deps });
    expect(deps.editTicket).toHaveBeenCalled();
  });
});
