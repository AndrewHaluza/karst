import { describe, it, expect, vi } from 'vitest';
import { resolveConflictClick, makeSessionHandOff } from './conflictResolveOps.js';

function click(over: Partial<Parameters<typeof resolveConflictClick>[0]> = {}) {
  const notify = vi.fn();
  const deliver = vi.fn();
  const briefFor = vi.fn(() => 'BRIEF' as string | null);
  return {
    input: {
      repo: '/repos/api',
      label: 'T7',
      hasSandbox: async () => false,
      briefFor,
      notify,
      deliver,
      ...over,
    },
    notify,
    deliver,
    briefFor,
  };
}

describe('resolveConflictClick', () => {
  it('passes the runners’ sandbox answer to the brief builder', async () => {
    const hasSandbox = vi.fn(async () => true);
    const { input, briefFor } = click({ hasSandbox });

    await resolveConflictClick(input);

    expect(hasSandbox).toHaveBeenCalledTimes(1);
    expect(briefFor).toHaveBeenCalledWith(true);
  });

  it('treats an undefined probe answer as no sandbox', async () => {
    const { input, briefFor } = click({ hasSandbox: async () => undefined });

    await resolveConflictClick(input);

    expect(briefFor).toHaveBeenCalledWith(false);
  });

  it('delivers the brief with the repo the click named', async () => {
    const { input, deliver, notify } = click();

    await resolveConflictClick(input);

    expect(deliver).toHaveBeenCalledWith('BRIEF', '/repos/api');
    expect(notify).not.toHaveBeenCalled();
  });

  // A null brief is the store saying this repo is not conflicted. Opening a
  // generic session instead would send the agent at nothing.
  it('notifies and delivers nothing when the store has no conflict', async () => {
    const { input, deliver, notify } = click({ briefFor: () => null });

    await resolveConflictClick(input);

    expect(deliver).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(
      'No merge conflict is recorded for "/repos/api" on ticket T7 — nothing to resolve.',
    );
  });
});

function handOff(over: Partial<Parameters<typeof makeSessionHandOff>[0]> = {}) {
  const deps = {
    isGraphTicket: () => false,
    nudge: () => false,
    focus: vi.fn(),
    open: vi.fn(),
    ...over,
  };
  return { run: makeSessionHandOff(deps), deps };
}

describe('makeSessionHandOff', () => {
  it('nudges a live session and reveals it, without launching', () => {
    const { run, deps } = handOff({ nudge: () => true });

    run('BRIEF', '/repos/api');

    expect(deps.focus).toHaveBeenCalledTimes(1);
    expect(deps.open).not.toHaveBeenCalled();
  });

  it('launches with the brief and the repo when no session is live', () => {
    const { run, deps } = handOff();

    run('BRIEF', '/repos/api');

    expect(deps.open).toHaveBeenCalledWith('BRIEF', '/repos/api');
    expect(deps.focus).not.toHaveBeenCalled();
  });

  // The graph coordinator owns graph tickets' sessions; a hand-off must not
  // start a second one beside it.
  it('does nothing for a graph ticket', () => {
    const nudge = vi.fn(() => false);
    const { run, deps } = handOff({ isGraphTicket: () => true, nudge });

    run('BRIEF', '/repos/api');

    expect(nudge).not.toHaveBeenCalled();
    expect(deps.focus).not.toHaveBeenCalled();
    expect(deps.open).not.toHaveBeenCalled();
  });
});
