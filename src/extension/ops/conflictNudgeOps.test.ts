import { describe, expect, it, vi } from 'vitest';
import { makeConflictDelivery } from './conflictNudgeOps.js';

function rig(live = true) {
  const log: string[] = [];
  const nudge = vi.fn((_id: number, _text: string) => live);
  const focus = vi.fn();
  const open = vi.fn();
  const d = makeConflictDelivery({ nudge, focus, open, pointer: (_id, repo) => `POINTER:${repo}`, key: () => 'T9', debug: (m) => log.push(m) });
  return { d, nudge, focus, open, log };
}

describe('makeConflictDelivery', () => {
  it('types the short pointer, not the brief, into a live host session', () => {
    const { d, nudge, focus, open, log } = rig();
    d.deliver(1, 'FULL BRIEF', '/r', false);
    expect(nudge).toHaveBeenCalledWith(1, 'POINTER:/r');
    expect(focus).toHaveBeenCalledWith(1);
    expect(open).not.toHaveBeenCalled();
    expect(log).toEqual(['[ship] autopilot ticket T9: conflict brief sent to the live session as a pointer']);
  });

  it('types the full brief for a sandboxed session (no host CLI there)', () => {
    const { d, nudge } = rig();
    d.deliver(1, 'FULL BRIEF', '/r', true);
    expect(nudge).toHaveBeenCalledWith(1, 'FULL BRIEF');
  });

  it('seeds a new session with the full brief', () => {
    const { d, open, log } = rig(false);
    d.deliver(1, 'FULL BRIEF', '/r', false);
    expect(open).toHaveBeenCalledWith(1, 'FULL BRIEF', '/r');
    expect(log).toEqual(['[ship] autopilot ticket T9: conflict brief sent as the seed of a new session']);
  });

  it('re-sends the same text once to a live session and logs it', () => {
    const { d, nudge, log } = rig();
    d.deliver(1, 'FULL BRIEF', '/r', false);
    nudge.mockClear();
    expect(d.resend(1)).toBe(true);
    expect(nudge).toHaveBeenCalledWith(1, 'POINTER:/r');
    expect(log.at(-1)).toBe('[ship] autopilot ticket T9: conflict brief sent again to the live session');
  });

  it('re-sends nothing when no brief was typed or no session is live', () => {
    const a = rig();
    expect(a.d.resend(1)).toBe(false);
    const b = rig(false);
    b.d.deliver(1, 'B', '/r', false);
    expect(b.d.resend(1)).toBe(false);
    expect(b.log.at(-1)).toBe('[ship] autopilot ticket T9: conflict brief not sent again: no live session');
  });
});
