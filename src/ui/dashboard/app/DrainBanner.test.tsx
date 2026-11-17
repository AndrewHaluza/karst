// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { fireEvent } from '@testing-library/react';
import { drainBannerText } from './drainSlices.js';
import { installRuntimeDoubles } from './fixtures/prsPanelKit.js';
import { cleanupRail, go, mainLine, must, mountRail, needs, q, railState, TICKET } from './fixtures/railKit.js';

installRuntimeDoubles();
afterEach(cleanupRail);

const drain = (over: Record<string, unknown> = {}) => ({
  draining: true,
  live: [{ ticketKey: 'T1183', kind: 'deliver' }, { ticketKey: 'T1188', kind: 'ship' }],
  held: [],
  ...over,
});
const withDrain = (d: unknown, over: Record<string, unknown> = {}) => railState({ idLabel: 'T7', drain: d, ...over });
const banner = (): HTMLElement => must('[data-region="drain-banner"]');
const shown = (): boolean => !must('#blocked').classList.contains('hidden');

describe('DrainBanner — when it shows', () => {
  it('stays hidden when no reload waits, or the ticket is neither held, live nor at ship', () => {
    const h = mountRail(withDrain({ draining: false, live: [], held: [] }));
    expect(shown()).toBe(false);
    expect(q('[data-region="drain-banner"]')).toBeNull();
    h.emit({ type: 'state', state: withDrain(drain()) });
    expect(q('[data-region="drain-banner"]')).toBeNull();
    expect(shown()).toBe(false);
  });

  it('shows for a held ticket and for a ticket with a live run, and hides when the drain ends', () => {
    const h = mountRail(withDrain(drain({ held: [TICKET] })));
    expect(shown()).toBe(true);
    h.emit({ type: 'state', state: withDrain(drain({ live: [{ ticketKey: 'T7', kind: 'agent' }] })) });
    expect(banner().textContent).toContain('T7 agent');
    h.emit({ type: 'state', state: withDrain({ draining: false, live: [], held: [] }) });
    expect(shown()).toBe(false);
    expect(q('[data-region="drain-banner"]')).toBeNull();
  });

  it('shows on the ship stage for a ticket the drain does not name', () => {
    mountRail(withDrain(drain(), { stageCurrent: 'ship' }));
    expect(shown()).toBe(true);
  });

  it('words the live runs and the hold, and posts one cancel request', () => {
    const h = mountRail(withDrain(drain({ held: [TICKET] })));
    expect(banner().textContent).toContain('Reload waiting for 2 live runs: T1183 deliver, T1188 ship. Ship and new runs are held.');
    const cancel = must<HTMLButtonElement>('[data-region="drain-cancel"]');
    expect(cancel.textContent).toBe('Cancel reload');
    fireEvent.click(cancel);
    expect(h.send.cancelReload).toHaveBeenCalledTimes(1);
  });
});

describe('drainBannerText', () => {
  it('uses the singular for one run and a different sentence for none', () => {
    expect(drainBannerText({ draining: true, live: [{ ticketKey: 'T1', kind: 'gate' }], held: [] })).toBe('Reload waiting for 1 live run: T1 gate. Ship and new runs are held.');
    expect(drainBannerText({ draining: true, live: [], held: [] })).toBe('Reload starting. Ship and new runs are held.');
  });
});

describe('Confirm ship while a reload waits', () => {
  const ship = (d: unknown) =>
    withDrain(d, { main: mainLine('ship', { ship: { needsUser: true, needs: needs({ kind: 'ship-confirm' }, { action: 'Confirm ship' }) } }), stageCurrent: 'ship' });

  it('is disabled with the reason in its title, and a click posts nothing', () => {
    const h = mountRail(ship(drain()));
    expect(go().disabled).toBe(true);
    expect(go().title).toBe('Confirm ship — a reload is waiting for live runs. Cancel the reload to continue');
    fireEvent.click(go());
    expect(h.send.shipTicket).not.toHaveBeenCalled();
  });

  it('is enabled and untitled when no reload waits', () => {
    mountRail(ship({ draining: false, live: [], held: [] }));
    expect(go().disabled).toBe(false);
    expect(go().hasAttribute('title')).toBe(false);
  });
});
