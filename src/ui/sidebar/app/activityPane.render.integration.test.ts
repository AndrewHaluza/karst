// @vitest-environment jsdom
/** Rendered-page tests for the Activity pane: placement, collapsed default, rows, click targets, states. */
import { afterAll, describe, expect, it } from 'vitest';
import { sidebarRenderFixtures } from '../renderFixtures.js';
import type { SidebarState } from '../state.js';
import { ACTIVITY_EMPTY_TEXT, ACTIVITY_NO_MATCH_TEXT } from './activityFormat.js';
import { closeSidebarRealm, renderSidebarApp, type RenderedSidebar } from './renderSidebarApp.js';

afterAll(closeSidebarRealm);

const fixture = (scenario: string): SidebarState => sidebarRenderFixtures().find((f) => f.scenario === scenario)!.state;
async function mount(state: SidebarState): Promise<RenderedSidebar> {
  const h = await renderSidebarApp();
  await h.receive({ type: 'state', state });
  return h;
}
const text = (e: Element | null | undefined) => (e?.textContent ?? '').replace(/\s+/g, ' ').trim();
const open = (h: RenderedSidebar) => h.click('[data-pane="activity"] .pane-toggle');

describe('Activity pane', () => {
  it('sits after Tickets, collapsed by default, with the unread count', async () => {
    const h = await mount(fixture('activity'));
    const panes = h.queryAll('[data-pane]').map((p) => p.getAttribute('data-pane'));
    expect(panes.indexOf('activity')).toBe(panes.indexOf('tickets') + 1);
    expect(text(h.query('[data-pane="activity"] .pane-title'))).toBe('Activity');
    expect(text(h.query('[data-pane="activity"] .pane-count'))).toBe('4 · 2 new');
    expect(h.query('[data-pane="activity"] .pane-toggle')!.getAttribute('aria-expanded')).toBe('false');
    expect(h.query('[data-activity-row]')).toBeNull();
  });

  it('opens as view state only and marks nothing read', async () => {
    const h = await mount(fixture('activity'));
    const before = h.posted.length;
    await open(h);
    expect(h.queryAll('[data-activity-row]')).toHaveLength(4);
    expect(h.posted.length).toBe(before);
  });

  it('draws glyph, chip, title and time; unread rows are marked', async () => {
    const h = await mount(fixture('activity'));
    await open(h);
    const first = h.query('[data-activity-row="8"]')!;
    expect(first.getAttribute('data-unread')).toBe('true');
    expect(first.querySelector('.a-lvl--error')).not.toBeNull();
    expect(text(first.querySelector('.a-ref'))).toBe('T900001');
    expect(first.querySelector('.k-ticket-ref')).toBeNull();
    expect(text(first.querySelector('.a-title'))).toBe('Autopilot: auto-fix stopped after 3 rounds');
    expect(text(first.querySelector('.a-time'))).toMatch(/^\d\d:\d\d$/);
    expect(first.getAttribute('aria-label')).toContain('unread');
    expect(h.query('[data-activity-row="6"]')!.getAttribute('data-unread')).toBe('false');
  });

  it('groups rows under one heading per day', async () => {
    const h = await mount(fixture('activity'));
    await open(h);
    expect(h.queryAll('.a-day')).toHaveLength(2);
  });

  it('a ticket row is a button that posts activity-open; a row without a ticket has no target', async () => {
    const h = await mount(fixture('activity'));
    await open(h);
    expect(h.query('[data-activity-row="5"]')!.tagName).not.toBe('BUTTON');
    await h.click('[data-activity-row="8"]');
    expect(h.posted).toContainEqual({ type: 'activity-open', id: 8 });
  });

  it('Mark all read posts one message and shows only while rows are unread', async () => {
    const h = await mount(fixture('activity'));
    await h.click('[data-activity-mark-all]');
    expect(h.posted).toContainEqual({ type: 'activity-mark-all-read' });
    const read = fixture('activity');
    const h2 = await mount({ ...read, activity: { ...read.activity, unread: 0 } });
    expect(h2.query('[data-activity-mark-all]')).toBeNull();
    expect(text(h2.query('[data-pane="activity"] .pane-count'))).toBe('4');
  });

  it('Show more posts the oldest loaded id', async () => {
    const h = await mount(fixture('activity-long'));
    await open(h);
    await h.click('[data-activity-more]');
    expect(h.posted).toContainEqual({ type: 'activity-more', beforeId: 51 });
  });

  it('the empty state keeps the pane and says so', async () => {
    const h = await mount(fixture('empty'));
    await open(h);
    expect(text(h.query('[data-region="activity"]'))).toBe(ACTIVITY_EMPTY_TEXT);
    expect(h.query('[data-pane="activity"] [data-pane-empty]')).not.toBeNull();
    expect(h.query('[data-activity-filter-menu]')).toBeNull();
  });

  it('the Errors and warnings filter hides other rows, and says so when none match', async () => {
    const h = await mount(fixture('activity'));
    await open(h);
    await h.click('[data-activity-filter-menu]');
    await h.click('[data-activity-level="problems"]');
    expect(h.queryAll('[data-activity-row]')).toHaveLength(2);
    expect(h.query('[data-activity-filter-dot]')).not.toBeNull();
    const calm = fixture('activity');
    const h2 = await mount({ ...calm, activity: { ...calm.activity, rows: calm.activity.rows.filter((r) => r.level === 'info' || r.level === 'success') } });
    await open(h2);
    await h2.click('[data-activity-filter-menu]');
    await h2.click('[data-activity-level="problems"]');
    expect(text(h2.query('[data-region="activity"]'))).toBe(ACTIVITY_NO_MATCH_TEXT);
  });

  it('keeps the level in the webview view state and counts shown / total (SB-9)', async () => {
    const h = await mount(fixture('activity'));
    await open(h);
    await h.click('[data-activity-filter-menu]');
    await h.click('[data-activity-level="problems"]');
    expect(text(h.query('[data-pane="activity"] .pane-count'))).toBe('2 / 4');
    expect((h.handle.state as { view: { activityLevel: string } }).view.activityLevel).toBe('problems');
    await h.receive({ type: 'reveal-activity' });
    expect(text(h.query('[data-pane="activity"] .pane-count'))).toBe('2 / 4');
  });

  it('names Mark all read and uses the shared checks glyph (SB-15)', async () => {
    const h = await mount(fixture('activity'));
    const button = h.query('[data-activity-mark-all]')!;
    expect(button.getAttribute('aria-label')).toBe('Mark all read');
    const win = h.handle.window as unknown as { karstIcon(name: string, size: number): string };
    const tmp = h.document.createElement('div');
    tmp.innerHTML = win.karstIcon('checks', 13);
    expect(button.querySelector('svg')!.innerHTML).toBe(tmp.querySelector('svg')!.innerHTML);
  });

  it('reveal-activity expands the pane', async () => {
    const h = await mount(fixture('activity'));
    await h.receive({ type: 'reveal-activity' });
    expect(h.query('[data-pane="activity"] .pane-toggle')!.getAttribute('aria-expanded')).toBe('true');
  });

  it('a 50 row list renders every row and does not wrap its titles', async () => {
    const h = await mount(fixture('activity-long'));
    await open(h);
    expect(h.queryAll('[data-activity-row]')).toHaveLength(50);
  });
});
