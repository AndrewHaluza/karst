import { describe, it, expect, vi } from 'vitest';
import { ActiveTicketTracker } from './activeTicket.js';

describe('ActiveTicketTracker', () => {
  it('starts with no active ticket', () => {
    expect(new ActiveTicketTracker().get()).toBeNull();
  });

  it('marks the ticket active and notifies', () => {
    const tracker = new ActiveTicketTracker();
    const spy = vi.fn();
    tracker.onDidChange(spy);

    tracker.set(3, true);

    expect(tracker.get()).toBe(3);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('switching to another ticket moves the highlight', () => {
    const tracker = new ActiveTicketTracker();
    tracker.set(3, true);
    tracker.set(7, true);
    expect(tracker.get()).toBe(7);
  });

  it('clears when the ACTIVE ticket loses focus', () => {
    const tracker = new ActiveTicketTracker();
    tracker.set(3, true);
    tracker.set(3, false);
    expect(tracker.get()).toBeNull();
  });

  it('a deactivation for a ticket that is not current leaves the highlight alone', () => {
    // The direct A→B tab switch, one event order: B reports first, then the
    // old panel's deactivation arrives — it must not clear the newer mark.
    const tracker = new ActiveTicketTracker();
    tracker.set(3, true);
    tracker.set(7, true);
    tracker.set(3, false);
    expect(tracker.get()).toBe(7);
  });

  it('a disposed panel reporting false for the active ticket clears it', () => {
    // Closing the active tab disposes the panel; nothing else reports focus,
    // so the dispose-time `false` is the only signal that the view is gone.
    const tracker = new ActiveTicketTracker();
    tracker.set(3, true);
    tracker.set(3, false);
    expect(tracker.get()).toBeNull();
  });

  it('a no-op set fires no notification', () => {
    const tracker = new ActiveTicketTracker();
    const spy = vi.fn();
    tracker.onDidChange(spy);
    tracker.set(3, true);
    spy.mockClear();

    tracker.set(3, true);
    tracker.set(5, false);

    expect(spy).not.toHaveBeenCalled();
    expect(tracker.get()).toBe(3);
  });

  it('notifies every subscriber', () => {
    const tracker = new ActiveTicketTracker();
    const a = vi.fn();
    const b = vi.fn();
    tracker.onDidChange(a);
    tracker.onDidChange(b);

    tracker.set(3, true);

    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });
});
