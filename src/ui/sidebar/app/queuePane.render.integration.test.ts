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
    expect(text(first.querySelector('.q-why'))).toBe('↑ D498');
    const ticket = h.query('[data-queue-row="T997"]')!;
    expect(text(ticket.querySelector('.q-id'))).toBe('T997');
    expect(text(ticket.querySelector('.q-why'))).toBe('waits T12');
    expect(h.query('[data-queue-row="D461"] .q-why')!.className).toContain('q-why--cycle');
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

  it('lists 40 items in the scrolling region', async () => {
    const h = await mount(fixture('queue-long'));
    await open(h);
    expect(h.queryAll('[data-queue-row]')).toHaveLength(40);
    expect(h.queryAll('[data-region="queue"]')).toHaveLength(1);
  });
});
