import { describe, expect, it } from 'vitest';
import { HOST_RUN_LABEL, IDLE_DRAIN_INPUT, drainView } from './stateDrain.js';

describe('drainView', () => {
  it('is idle when no reload waits, even if stale runs are passed', () => {
    expect(drainView(IDLE_DRAIN_INPUT)).toEqual({ draining: false, live: [], held: [] });
    expect(drainView({ draining: false, live: [{ ticketId: 1, kind: 'ship' }], held: [2] })).toEqual({ draining: false, live: [], held: [] });
  });

  it('names each live run by ticket id and kind and copies the held ids', () => {
    const held = [4];
    const view = drainView({ draining: true, live: [{ ticketId: 1183, kind: 'deliver' }, { ticketId: null, kind: 'gate' }], held });
    expect(view).toEqual({
      draining: true,
      live: [{ ticketKey: 'T1183', kind: 'deliver' }, { ticketKey: HOST_RUN_LABEL, kind: 'gate' }],
      held: [4],
    });
    expect(view.held).not.toBe(held);
  });
});
