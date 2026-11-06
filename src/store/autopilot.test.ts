import { describe, expect, it } from 'vitest';
import { openStore } from './db.js';
import { createTicket } from './tickets.js';
import {
  claimAutopilotTicket,
  decideBudget, effectiveAutopilot, getAutopilotBudget, getAutopilotTicket, grantAutopilotExtra, pausedReason,
  setAutopilotOverride, setAutopilotPaused, setAutopilotStopAfter, stoppedReason, takeAutopilotAttempt,
} from './autopilot.js';

describe('decideBudget', () => {
  it('counts attempts up to the max, then refuses', () => {
    let b = { attempts: 0, signature: null as string | null, extra: 0 };
    const seen: boolean[] = [];
    for (let i = 0; i < 3; i++) {
      const r = decideBudget(b, 'sig', 2);
      b = r.next;
      seen.push(r.decision.ok);
    }
    expect(seen).toEqual([true, true, false]);
    expect(b.attempts).toBe(2);
  });

  it('resets attempts and extras when the signature changes', () => {
    const r = decideBudget({ attempts: 2, signature: 'a', extra: 1 }, 'b', 2);
    expect(r.next).toEqual({ attempts: 1, signature: 'b', extra: 0 });
    expect(r.decision).toEqual({ ok: true, used: 1, max: 2 });
  });

  it('keeps counting on a repeated signature (loop guard) and honours extras', () => {
    expect(decideBudget({ attempts: 2, signature: 'a', extra: 0 }, 'a', 2).decision).toEqual({ ok: false, used: 2, max: 2 });
    expect(decideBudget({ attempts: 2, signature: 'a', extra: 1 }, 'a', 2).decision).toEqual({ ok: true, used: 3, max: 3 });
  });
});

describe('autopilot store', () => {
  const setup = () => {
    const store = openStore(':memory:');
    const parent = createTicket(store, { key: 'P-1', title: 'p', source: 'manual' });
    const child = createTicket(store, { key: 'C-1', title: 'c', source: 'manual', subtaskParentId: parent.id });
    return { store, parent: parent.id, child: child.id };
  };

  it('resolves inherit / on / off and lets a sub-task inherit the parent', () => {
    const { store, parent, child } = setup();
    expect(effectiveAutopilot(store, child, false)).toBe(false);
    expect(effectiveAutopilot(store, child, true)).toBe(true);
    setAutopilotOverride(store, parent, 'on');
    expect(effectiveAutopilot(store, child, false)).toBe(true);
    setAutopilotOverride(store, child, 'off');
    expect(effectiveAutopilot(store, child, true)).toBe(false);
    setAutopilotOverride(store, child, 'inherit');
    expect(effectiveAutopilot(store, child, false)).toBe(true);
    setAutopilotOverride(store, parent, 'off');
    expect(effectiveAutopilot(store, child, true)).toBe(false);
  });

  it('rejects an unknown override', () => {
    const { store, parent } = setup();
    expect(() => setAutopilotOverride(store, parent, 'maybe' as never)).toThrow(/override must be one of/);
  });

  it('persists attempts per (ticket, repo, kind) and resets on a new signature', () => {
    const { store, parent } = setup();
    expect(takeAutopilotAttempt(store, parent, 'r', 'conflicts', 'base1', 2)).toEqual({ ok: true, used: 1, max: 2 });
    expect(takeAutopilotAttempt(store, parent, 'r', 'conflicts', 'base1', 2)).toEqual({ ok: true, used: 2, max: 2 });
    expect(takeAutopilotAttempt(store, parent, 'r', 'conflicts', 'base1', 2)).toEqual({ ok: false, used: 2, max: 2 });
    expect(takeAutopilotAttempt(store, parent, 'r', 'ci', 'lint', 3).ok).toBe(true);
    expect(takeAutopilotAttempt(store, parent, 'r', 'conflicts', 'base2', 2)).toEqual({ ok: true, used: 1, max: 2 });
    expect(getAutopilotBudget(store, parent, 'r', 'conflicts').signature).toBe('base2');
  });

  it('approve-one-more adds one attempt without resetting, and clears pause and stop', () => {
    const { store, parent } = setup();
    takeAutopilotAttempt(store, parent, 'r', 'ci', 'x', 1);
    expect(takeAutopilotAttempt(store, parent, 'r', 'ci', 'x', 1).ok).toBe(false);
    setAutopilotStopAfter(store, parent);
    setAutopilotPaused(store, parent, 'read-only');
    const b = grantAutopilotExtra(store, parent, 'r', 'ci');
    expect(b).toEqual({ attempts: 1, signature: 'x', extra: 1 });
    expect(getAutopilotTicket(store, parent)).toEqual({ mode: 'inherit', stopAfter: false, pausedReason: null, stoppedReason: null });
    expect(takeAutopilotAttempt(store, parent, 'r', 'ci', 'x', 1)).toEqual({ ok: true, used: 2, max: 2 });
  });

  it('formats the park reasons', () => {
    expect(stoppedReason('ci', 3, 3)).toBe('auto-fix stopped: ci 3/3');
    expect(pausedReason('is read-only')).toBe('auto-fix paused: sandbox is read-only');
  });
});

describe('claimAutopilotTicket', () => {
  it('lets one owner hold the lease, renews it for that owner and hands it over after expiry', () => {
    const store = openStore(':memory:');
    const id = createTicket(store, { key: 'C-1', title: 't' }).id;
    expect(claimAutopilotTicket(store, id, 'A', 1000, 500)).toBe(true);
    expect(claimAutopilotTicket(store, id, 'B', 1200, 500)).toBe(false);
    expect(claimAutopilotTicket(store, id, 'A', 1400, 500)).toBe(true);
    expect(claimAutopilotTicket(store, id, 'B', 1899, 500)).toBe(false);
    expect(claimAutopilotTicket(store, id, 'B', 1900, 500)).toBe(true);
  });
});
