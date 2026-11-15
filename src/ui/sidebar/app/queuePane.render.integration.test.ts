// @vitest-environment jsdom
/** Rendered-page tests for the Queue pane: placement, collapsed default, rows, click targets, states. */
import { afterAll, describe, expect, it } from 'vitest';
import { sidebarRenderFixtures } from '../renderFixtures.js';
import type { SidebarState } from '../state.js';
import { QUEUE_EMPTY_TEXT } from './QueuePane.js';
import { closeSidebarRealm, renderSidebarApp, type RenderedSidebar } from './renderSidebarApp.js';

afterAll(closeSidebarRealm);

const fixture = (scenario: string): SidebarState => sidebarRenderFixtures().find((f) => f.scenario === scenario)!.state;
async function mount(state: SidebarState): Promise<RenderedSidebar> {
  const h = await renderSidebarApp();
  await h.receive({ type: 'state', state });
  return h;
}
const text = (e: Element | null | undefined) => (e?.textContent ?? '').replace(/\s+/g, ' ').trim();
const sent = (h: RenderedSidebar) => h.posted.filter((m) => m.type !== 'request-state');
const open = (h: RenderedSidebar) => h.click('[data-pane="queue"] .pane-toggle');

describe('Queue pane', () => {
  it('sits between Planning and Tickets, collapsed by default, with its count', async () => {
    const h = await mount(fixture('queue'));
    const panes = h.queryAll('[data-pane]').map((p) => p.getAttribute('data-pane'));
    expect(panes.indexOf('queue')).toBe(panes.indexOf('planning') + 1);
    expect(panes.indexOf('tickets')).toBe(panes.indexOf('queue') + 1);
    expect(text(h.query('[data-pane="queue"] .pane-title'))).toBe('Queue');
    expect(text(h.query('[data-pane="queue"] .pane-count'))).toBe('6');
    expect(h.query('[data-pane="queue"] .pane-toggle')!.getAttribute('aria-expanded')).toBe('false');
    expect(h.query('[data-queue-row]')).toBeNull();
  });

  it('opens as view state only: no message is posted', async () => {
    const h = await mount(fixture('queue'));
    const before = h.posted.length;
    await open(h);
    expect(h.queryAll('[data-queue-row]')).toHaveLength(6);
    expect(h.posted.length).toBe(before);
  });

  it('draws position, chip, id with session, title and reason on one row', async () => {
    const h = await mount(fixture('queue'));
    await open(h);
    const first = h.query('[data-queue-row="D497"]')!;
    expect(text(first.querySelector('.q-pos'))).toBe('1');
    expect(first.querySelector('.k-pri')).not.toBeNull();
    expect(text(first.querySelector('.q-id'))).toBe('D497 · P17');
    expect(text(first.querySelector('.q-title'))).toBe('Add the shared retry helper');
    const ticket = h.query('[data-queue-row="T997"]')!;
    expect(text(ticket.querySelector('.q-id'))).toBe('T997');
  });

  it('draws the reason as the verb and the stage chip, never as muted text', async () => {
    const h = await mount(fixture('queue'));
    await open(h);
    expect(h.query('.q-why')).toBeNull();
    const raised = h.query('[data-queue-row="D497"] .q-rel--raised')!;
    expect(text(raised.querySelector('.refs-verb'))).toBe('Unblocks');
    expect(raised.querySelector('.k-ticket-ref')!.textContent).toContain('D498');
    expect(h.query('[data-queue-row="D497"] .k-pri .k-pri-up')).not.toBeNull();
    expect(h.query('[data-queue-row="D498"] .k-pri-up')).toBeNull();
    const waits = h.query('[data-queue-row="T997"] .q-rel--waits')!;
    expect(text(waits.querySelector('.refs-verb'))).toBe('Waits on');
    expect(waits.querySelector('.k-ticket-ref')!.textContent).toContain('T12');
    expect(text(waits.querySelector('.refs-more'))).toBe('+1');
    const cycle = h.query('[data-queue-row="D461"] .q-rel--cycle')!;
    expect(text(cycle.querySelector('.refs-verb'))).toBe('Cycle with');
    expect(cycle.querySelector('.q-rel-icon')).not.toBeNull();
    expect(cycle.querySelector('.k-ticket-ref')!.textContent).toContain('D462');
  });

  it('keeps the main button, the relation and the menu as siblings (UI-R09)', async () => {
    const h = await mount(fixture('queue'));
    await open(h);
    for (const row of h.queryAll('.q-row')) {
      expect(row.querySelector('.q-main a, .q-main button, .q-main .refs')).toBeNull();
    }
    const kids = [...h.query('[data-queue-row="T997"]')!.children].map((c) => c.className.split(' ')[0]);
    expect(kids).toEqual(['q-main', 'refs', 'k-iconbtn']);
  });

  it('keeps the raised fact in the name of the main button', async () => {
    const h = await mount(fixture('queue'));
    await open(h);
    expect(h.query('[data-queue-row="D497"] .q-main')!.getAttribute('aria-label')).toContain('Raised to urgent because D498 waits on it');
    expect(h.query('[data-queue-row="D461"] .q-main')!.getAttribute('aria-label')).toContain('wait on each other');
  });

  it('the +N button opens the rest of the list in the row', async () => {
    const h = await mount(fixture('queue'));
    await open(h);
    await h.click('[data-queue-row="T997"] .refs-more');
    expect(h.query('[data-queue-row="T997"] .refs-list')!.hasAttribute('hidden')).toBe(false);
  });

  it('shows no priority chip for a normal item', async () => {
    const h = await mount(fixture('queue'));
    await open(h);
    expect(h.query('[data-queue-row="D461"] .k-pri')).toBeNull();
  });

  it('a click opens a draft Review and a ticket dashboard', async () => {
    const h = await mount(fixture('queue'));
    await open(h);
    await h.click('[data-queue-row="D497"] .q-main');
    await h.click('[data-queue-row="T997"] .q-main');
    expect(sent(h)).toMatchObject([
      { type: 'plan-proposal-review' },
      { type: 'open-dashboard' },
    ]);
  });

  it('the row menu offers the Priority submenu', async () => {
    const h = await mount(fixture('queue'));
    await open(h);
    await h.click('[data-queue-row="D452"] .q-menu');
    expect(text(h.query('[role="menu"]'))).toContain('Priority');
  });

  it('the row menu opens and stays open after the click, then lists the four levels', async () => {
    const h = await mount(fixture('queue'));
    await open(h);
    // The ContextMenu outside-click rule keeps a menu open only for a trigger with data-menu.
    expect(h.query('[data-queue-row="D452"] .q-menu')!.getAttribute('data-menu')).toBe('qD452');
    await h.click('[data-queue-row="D452"] .q-menu');
    expect(h.query('#ctxMenu')!.classList.contains('open')).toBe(true);
    expect(text(h.query('#ctxMenu'))).toContain('Priority');
    expect(h.query('[data-queue-row="D452"] .q-menu')!.getAttribute('aria-expanded')).toBe('true');
    await h.click('#ctxMenu [role="menuitem"]');
    expect(h.queryAll('#ctxMenu [role="menuitemradio"]').map((i) => text(i))).toEqual(['Urgent', 'High', 'Normal', 'Low', 'Clear']);
  });

  it('shows the empty text', async () => {
    const h = await mount(fixture('empty'));
    await open(h);
    expect(text(h.query('[data-pane="queue"] .pane-empty'))).toBe(QUEUE_EMPTY_TEXT);
    expect(text(h.query('[data-pane="queue"] .pane-count'))).toBe('0');
  });

  it('draws a pre-upgrade snapshot row with no relation chip fields, so a restored state does not blank the page', async () => {
    const state = fixture('queue');
    const chipFields = new Set(['waitsOnRefs', 'inheritedRef', 'cycleRef']);
    const rows = state.queue.rows.map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => !chipFields.has(k))) as typeof r);
    const h = await mount({ ...state, queue: { ...state.queue, rows } });
    await open(h);
    expect(h.queryAll('[data-queue-row]')).toHaveLength(rows.length);
    expect(h.query('.q-rel')).toBeNull();
  });

  it('lists 40 items in the scrolling region', async () => {
    const h = await mount(fixture('queue-long'));
    await open(h);
    expect(h.queryAll('[data-queue-row]')).toHaveLength(40);
    expect(h.queryAll('[data-region="queue"]')).toHaveLength(1);
  });
});
