import type { SandboxProbe } from '../../agent/sessionRunner.js';
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
      probeSandbox: async (): Promise<SandboxProbe> => ({ state: 'absent' }),
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
    const probeSandbox = vi.fn(async (): Promise<SandboxProbe> => ({ state: 'present' }));
    const { input, briefFor } = click({ probeSandbox });

    await resolveConflictClick(input);

    expect(probeSandbox).toHaveBeenCalledTimes(1);
    expect(briefFor).toHaveBeenCalledWith(true);
  });

  it('absent reads as the host brief', async () => {
    const { input, briefFor } = click({ probeSandbox: async () => ({ state: 'absent' }) });

    await resolveConflictClick(input);

    expect(briefFor).toHaveBeenCalledWith(false);
  });

  // arch:AC-39: a probe that cannot tell must not fall back to the host brief.
  it('an unknown probe picks no brief and shows the reason', async () => {
    const { input, briefFor, deliver, notify } = click({ probeSandbox: async () => ({ state: 'unknown', reason: 'sbx ls failed: spawn sbx ENOENT' }) });

    await resolveConflictClick(input);

    expect(briefFor).not.toHaveBeenCalled();
    expect(deliver).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('sbx ls failed: spawn sbx ENOENT'));
  });

  // Both call sites start the click with `void`: a rejected probe must still surface, as unknown.
  it('a rejected probe is unknown: no brief, a message, no rejection', async () => {
    const { input, briefFor, deliver, notify } = click({
      probeSandbox: async () => {
        throw new Error('runner listing failed');
      },
    });

    await expect(resolveConflictClick(input)).resolves.toBeUndefined();

    expect(briefFor).not.toHaveBeenCalled();
    expect(deliver).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('runner listing failed'));
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

describe('resolveConflictClick arm', () => {
  it('arms the repo right before the brief goes out', async () => {
    const order: string[] = [];
    const { input } = click({ arm: (r) => order.push(`arm:${r}`), deliver: () => order.push('deliver') });
    await resolveConflictClick(input);
    expect(order).toEqual(['arm:/repos/api', 'deliver']);
  });
  it('does not arm when there is no brief to send', async () => {
    const arm = vi.fn();
    const { input } = click({ arm, briefFor: () => null });
    await resolveConflictClick(input);
    expect(arm).not.toHaveBeenCalled();
  });
});
