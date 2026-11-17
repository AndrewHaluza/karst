import { afterEach, describe, expect, it, vi } from 'vitest';
import { IDLE_DRAIN, bindReloadDrain, cancelReloadDrain, drainSignature, drainSnapshot, onDrainChange } from './reloadDrainView.js';

const SNAP = { draining: true, live: [{ ticketId: 1, kind: 'ship' as const }], held: [2] };

afterEach(() => {
  bindReloadDrain(() => IDLE_DRAIN, () => {})(); // leaves the module unbound
});

describe('reloadDrainView', () => {
  it('is idle until a reload binds, then reads the bound source, then idle again', () => {
    expect(drainSnapshot()).toBe(IDLE_DRAIN);
    const unbind = bindReloadDrain(() => SNAP, () => {});
    expect(drainSnapshot()).toBe(SNAP);
    unbind();
    expect(drainSnapshot()).toBe(IDLE_DRAIN);
  });

  it('cancels through the bound hook, and reports false when no reload waits', () => {
    expect(cancelReloadDrain()).toBe(false);
    const cancel = vi.fn();
    const unbind = bindReloadDrain(() => SNAP, cancel);
    expect(cancelReloadDrain()).toBe(true);
    expect(cancel).toHaveBeenCalledTimes(1);
    unbind();
    expect(cancelReloadDrain()).toBe(false);
  });

  it('notifies on bind and unbind, survives a throwing listener, and stops after unsubscribe', () => {
    const seen = vi.fn();
    const off = onDrainChange(() => {
      throw new Error('boom');
    });
    const off2 = onDrainChange(seen);
    const unbind = bindReloadDrain(() => SNAP, () => {});
    unbind();
    expect(seen).toHaveBeenCalledTimes(2);
    off();
    off2();
    bindReloadDrain(() => SNAP, () => {})();
    expect(seen).toHaveBeenCalledTimes(2);
  });

  it('does not unbind a newer binding', () => {
    const first = bindReloadDrain(() => SNAP, () => {});
    const second = bindReloadDrain(() => IDLE_DRAIN, () => {});
    first();
    expect(drainSnapshot()).toBe(IDLE_DRAIN);
    expect(cancelReloadDrain()).toBe(true);
    second();
  });

  it('signs two equal snapshots alike and two different ones apart', () => {
    expect(drainSignature(SNAP)).toBe(drainSignature({ ...SNAP, live: [{ ticketId: 1, kind: 'ship' }] }));
    expect(drainSignature(SNAP)).not.toBe(drainSignature({ ...SNAP, held: [] }));
    expect(drainSignature(SNAP)).not.toBe(drainSignature({ ...SNAP, live: [{ ticketId: 1, kind: 'gate' }] }));
    expect(drainSignature(SNAP)).not.toBe(drainSignature({ ...SNAP, draining: false }));
  });
});
