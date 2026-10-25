// @vitest-environment jsdom
/** The React header and the vanilla page must cooperate: popover dismissal, Escape order, ship sharing, the drawer, single posts. */
import { afterEach, describe, expect, it } from 'vitest';
import { drainReactWork, renderWebviewReady, type RenderHandle } from '../../testing/renderHarness.js';
import { populatedStateFor, shipPreviewStateFor } from '../renderFixtures.js';
import type { DashboardState } from '../state.js';
import { buildStageRail } from '../../../model/stageRail.js';

let h: RenderHandle | null = null;
afterEach(() => { h?.close(); h = null; });

const open = async (state: DashboardState = populatedStateFor('impl')): Promise<RenderHandle> => {
  h = await renderWebviewReady('dashboard');
  h.receive({ type: 'state', state });
  await drainReactWork(h);
  return h;
};
const click = async (v: RenderHandle, sel: string): Promise<void> => {
  v.click(sel);
  await drainReactWork(v);
};
const escape = async (v: RenderHandle): Promise<void> => {
  v.document.body.dispatchEvent(new v.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  await drainReactWork(v);
};
const types = (v: RenderHandle, from: number): string[] => (v.posted.slice(from) as Array<{ type: string }>).map((m) => m.type);
const isOpen = (v: RenderHandle, sel: string): boolean => v.query(sel)!.classList.contains('open') && !v.query(sel)!.classList.contains('hidden');
const railShip = (): DashboardState => {
  const s = shipPreviewStateFor('ready');
  const rail = buildStageRail(s.stepper, s.stepper, {
    current: 'ship', needsUser: true, needs: { detail: 'needs you', action: 'Ship', cta: { kind: 'ship-confirm' } },
  } as unknown as Parameters<typeof buildStageRail>[2]);
  return { ...s, rail } as DashboardState;
};

describe('React header / vanilla page interop — popovers', () => {
  it('a click on a vanilla control closes the open popover; a click inside the popover does not', async () => {
    const v = await open();
    await click(v, '#agentButton');
    expect(isOpen(v, '#agentPopover')).toBe(true);
    await click(v, '#agentPopover .fieldHelp');
    expect(isOpen(v, '#agentPopover')).toBe(true);
    await click(v, '#rail');
    expect(isOpen(v, '#agentPopover')).toBe(false);
    await click(v, '#moreBtn');
    expect(isOpen(v, '#menuPopover')).toBe(true);
    await click(v, '#inside');
    expect(isOpen(v, '#menuPopover')).toBe(false);
  });

  it('a click elsewhere in the header closes it, and one trigger replaces the other popover', async () => {
    const v = await open();
    await click(v, '#agentButton');
    await click(v, '#moreBtn');
    expect(isOpen(v, '#agentPopover')).toBe(false);
    expect(isOpen(v, '#menuPopover')).toBe(true);
    await click(v, '#title');
    expect(isOpen(v, '#menuPopover')).toBe(false);
  });

  it('Escape closes the ticket-data drawer first and leaves the header popover as it was', async () => {
    const v = await open();
    await click(v, '#moreBtn');
    await click(v, '#ticketDataBtn');
    expect(v.query('#ticketDataDrawer')!.classList.contains('open')).toBe(true);
    expect(isOpen(v, '#menuPopover')).toBe(false); // opening the drawer was a click in the header, outside the menu
    await click(v, '#agentButton');
    await escape(v);
    expect(v.query('#ticketDataDrawer')!.classList.contains('open')).toBe(false);
    expect(isOpen(v, '#agentPopover')).toBe(true);
    await escape(v);
    expect(isOpen(v, '#agentPopover')).toBe(true); // Escape never closed the header popovers
  });
});

describe('React header / vanilla page interop — actions', () => {
  it('a header action posts exactly once and holds the runtime pending class', async () => {
    const v = await open(populatedStateFor('ship'));
    const before = v.posted.length;
    await click(v, '#keyBtn');
    expect(v.posted.slice(before)).toMatchObject([{ type: 'copy-ticket-key' }]);
    expect(v.query('#keyBtn')!.classList.contains('is-pending')).toBe(true);
  });

  it('Close and Reopen post their payload-free message once', async () => {
    const v = await open({ ...populatedStateFor('impl'), canClose: true } as DashboardState);
    const before = v.posted.length;
    await click(v, '#closeTicket');
    expect(v.posted.slice(before)).toEqual([expect.objectContaining({ type: 'close-ticket' })]);
    expect(Object.keys(v.posted[before] as object).sort()).toEqual(['requestId', 'type']);
    v.receive({ type: 'state', state: { ...populatedStateFor('ship'), stageCurrent: 'closed', canClose: false, canReopen: true } });
    await drainReactWork(v);
    const mark = v.posted.length;
    await click(v, '#reopenTicket');
    expect(types(v, mark)).toEqual(['reopen-ticket']);
  });

  it('a menu item posts once and the gates answer draws the switches', async () => {
    const v = await open();
    v.receive({ type: 'gate-options', options: { uat: [{ name: 'lint', disabled: false }], review: [] } });
    await drainReactWork(v);
    await click(v, '#moreBtn');
    const before = v.posted.length;
    await click(v, '#pauseItem');
    await click(v, '[data-act="set-disabled-gates"][data-name="lint"]');
    expect(v.posted.slice(before)).toMatchObject([
      { type: 'pause-execution' },
      { type: 'set-disabled-gates', stage: 'uat', name: 'lint', disabled: true },
    ]);
  });

  it('the ticket-data button opens the drawer and posts nothing', async () => {
    const v = await open();
    const before = v.posted.length;
    await click(v, '#ticketDataBtn');
    expect(v.query('#ticketDataDrawer')!.classList.contains('open')).toBe(true);
    expect(v.posted.length).toBe(before);
  });
});

describe('React header / vanilla page interop — Confirm ship', () => {
  it('posts ship-ticket once, shows Shipping..., and the rail Ship button goes busy with it', async () => {
    const v = await open(railShip());
    const before = v.posted.length;
    await click(v, '#confirmShip');
    await click(v, '#confirmShip');
    expect(v.posted.slice(before)).toEqual([{ type: 'ship-ticket' }]);
    expect(v.query('#confirmShip')!.textContent).toBe('Shipping…');
    expect((v.query('#confirmShip') as HTMLButtonElement).disabled).toBe(true);
    expect(v.query('.go[data-act="ship-ticket"]')!.getAttribute('aria-busy')).toBe('true');
  });

  it('a Ship started from the rail puts the header button in Shipping... and the header posts nothing', async () => {
    const v = await open(railShip());
    const before = v.posted.length;
    await click(v, '.go[data-act="ship-ticket"]');
    expect(types(v, before)).toEqual(['ship-ticket']);
    expect(v.query('#confirmShip')!.textContent).toBe('Shipping…');
    await click(v, '#confirmShip');
    expect(types(v, before)).toEqual(['ship-ticket']);
  });

  it('a push past the ship stage settles the request and flashes the toast', async () => {
    const v = await open(railShip());
    await click(v, '#confirmShip');
    v.receive({ type: 'state', state: populatedStateFor('done') });
    await drainReactWork(v);
    expect(v.query('#confirmShip')!.hasAttribute('hidden')).toBe(true);
    expect(v.query('#toast')!.textContent).toBe('Shipped ✓');
    expect(v.errors).toEqual([]);
  });
});
