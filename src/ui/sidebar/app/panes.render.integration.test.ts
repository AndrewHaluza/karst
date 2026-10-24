// @vitest-environment jsdom
/**
 * Rendered-page tests for the two-pane layout (Planning / Tickets): always-visible
 * headers, per-pane collapse kept as view state, the Tickets filter menu, the
 * attention line, and the accepted-drafts disclosure.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { fixtureDraft, fixturePlanningRow, sidebarRenderFixtures } from '../renderFixtures.js';
import type { SidebarState } from '../state.js';
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
const withCounts = (state: SidebarState, counts: Partial<SidebarState['counts']>): SidebarState => ({ ...state, counts: { ...state.counts, ...counts } });

describe('toolbar', () => {
  it('keeps resources, token usage and settings only', async () => {
    const h = await mount(fixture('all-sections'));
    expect(h.queryAll('.toolbar [aria-label]').map((b) => b.getAttribute('aria-label'))).toEqual([
      'Open resource monitor', 'Open token usage', 'Open settings',
    ]);
    expect(h.query('.toolbar [data-act="create"],.toolbar [data-act="plan-create"]')).toBeNull();
  });
});

describe('pane headers', () => {
  it('are always visible, even with nothing to list', async () => {
    const h = await mount(fixture('empty'));
    const planning = h.query('[data-pane="planning"]')!;
    const tickets = h.query('[data-pane="tickets"]')!;
    expect(text(planning.querySelector('.pane-title'))).toBe('Planning');
    expect(text(planning.querySelector('.pane-count'))).toBe('0');
    expect(text(tickets.querySelector('.pane-title'))).toBe('Tickets');
    expect(text(tickets.querySelector('.pane-count'))).toBe('0');
    expect(planning.querySelector('.pane-toggle')!.getAttribute('aria-expanded')).toBe('true');
  });

  it('the + buttons reuse the plan-create and create actions', async () => {
    const h = await mount(fixture('empty'));
    await h.click('[data-pane="planning"] .pane-head [data-act="plan-create"]');
    await h.click('[data-pane="tickets"] .pane-head [data-act="create"]');
    expect(sent(h).map((m) => m.type)).toEqual(['plan-create', 'create']);
    expect(h.query('[data-pane="planning"] [data-act="plan-create"]')!.getAttribute('aria-label')).toBe('Start planning session');
    expect(h.query('[data-pane="tickets"] .pane-head [data-act="create"]')!.getAttribute('aria-label')).toBe('Create ticket');
  });

  it('counts the visible tickets and sessions', async () => {
    const h = await mount(fixture('all-sections'));
    expect(text(h.query('[data-pane="planning"] .pane-count'))).toBe('2');
    const secs = fixture('all-sections').sections;
    const total = secs.current.length + secs.awaitingReview.length + secs.recentlyDone.length + secs.olderDone.length;
    expect(text(h.query('[data-pane="tickets"] .pane-count'))).toBe(String(total));
  });

  it('collapsing hides the body, keeps the header, remembers it as view state and posts nothing', async () => {
    const h = await mount(fixture('all-sections'));
    const before = h.posted.length;
    await h.click('[data-pane="planning"] .pane-toggle');
    const toggle = h.query('[data-pane="planning"] .pane-toggle')!;
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(h.query('[data-pane="planning"] [role="tree"]')).toBeNull();
    expect(h.query('[data-pane="tickets"] .ticket')).not.toBeNull();
    expect(h.posted.length).toBe(before);
    expect((h.handle.state as { view: { collapsed: Record<string, boolean> } }).view.collapsed).toEqual({ planning: true, tickets: false });
    await h.click('[data-pane="tickets"] .pane-toggle');
    expect(h.query('[data-pane="tickets"] .ticket')).toBeNull();
    expect(h.query('[data-pane="tickets"] .pane-head [data-act="create"]')).not.toBeNull();
    expect(h.posted.length).toBe(before);
  });

  it('toggles from the keyboard (a real button) and survives a state push', async () => {
    const h = await mount(fixture('all-sections'));
    const toggle = h.query<HTMLButtonElement>('[data-pane="planning"] .pane-toggle')!;
    expect(toggle.tagName).toBe('BUTTON');
    expect(toggle.getAttribute('aria-controls')).toBe(h.query('[data-pane="planning"] .pane-body')!.id);
    await h.click(toggle);
    await h.receive({ type: 'state', state: fixture('all-sections') });
    expect(h.query('[data-pane="planning"] .pane-toggle')!.getAttribute('aria-expanded')).toBe('false');
  });

  it('Planning keeps Collapse all', async () => {
    const h = await mount(fixture('all-sections'));
    await h.click('[data-pane="planning"] [data-plan-collapse-all]');
    expect(h.query('[role="treeitem"][data-node="s90"]')!.getAttribute('aria-expanded')).toBe('false');
  });
});

describe('Tickets filter menu', () => {
  const open = async (h: RenderedSidebar) => h.click('[data-pane="tickets"] [data-filter-menu]');

  it('offers the five single-select presets, All checked by default and no dot', async () => {
    const h = await mount(fixture('all-sections'));
    expect(h.query('[data-facet]')).toBeNull();
    const btn = h.query('[data-filter-menu]')!;
    expect(btn.getAttribute('aria-haspopup')).toBe('menu');
    expect(btn.getAttribute('aria-expanded')).toBe('false');
    expect(h.query('[data-filter-dot]')).toBeNull();
    await open(h);
    expect(btn.getAttribute('aria-expanded')).toBe('true');
    const items = h.queryAll('[role="menuitemradio"]');
    expect(items.map(text)).toEqual(['All', 'Needs attention', 'In progress', 'Done', 'Archived']);
    expect(items.map((i) => i.getAttribute('aria-checked'))).toEqual(['true', 'false', 'false', 'false', 'false']);
  });

  it('Needs attention applies facets input + blocked through the existing messages', async () => {
    const h = await mount(fixture('all-sections'));
    await open(h);
    await h.click('[data-preset="attention"]');
    expect(sent(h)).toEqual([
      { type: 'toggle-facet', facet: 'all' },
      { type: 'toggle-facet', facet: 'input' },
      { type: 'toggle-facet', facet: 'failed' },
    ]);
    expect(h.query('[role="menuitemradio"]')).toBeNull();
  });

  it.each([['running', 'running'], ['done', 'done'], ['archived', 'archived']])('%s posts a reset then that facet', async (preset, facet) => {
    const h = await mount(fixture('all-sections'));
    await open(h);
    await h.click(`[data-preset="${preset}"]`);
    expect(sent(h)).toEqual([{ type: 'toggle-facet', facet: 'all' }, { type: 'toggle-facet', facet }]);
  });

  it('All posts one reset and picking the active preset posts nothing', async () => {
    const h = await mount({ ...fixture('all-sections'), facets: ['done'] });
    await open(h);
    await h.click('[data-preset="done"]');
    expect(sent(h)).toEqual([]);
    await open(h);
    await h.click('[data-preset="all"]');
    expect(sent(h)).toEqual([{ type: 'toggle-facet', facet: 'all' }]);
  });

  it('marks the active preset and shows a dot on the funnel', async () => {
    const h = await mount({ ...fixture('multi-facet'), facets: ['input', 'failed'] });
    expect(h.query('[data-filter-dot]')).not.toBeNull();
    expect(h.query('[data-filter-menu]')!.getAttribute('aria-label')).toBe('Filter tickets: Needs attention');
    await open(h);
    expect(h.query('[data-preset="attention"]')!.getAttribute('aria-checked')).toBe('true');
    expect(h.query('[data-preset="all"]')!.getAttribute('aria-checked')).toBe('false');
  });

  it('closes on Escape returning focus, supports arrow navigation, and closes on an outside click', async () => {
    const h = await mount(fixture('all-sections'));
    await open(h);
    const items = h.queryAll<HTMLElement>('[role="menuitemradio"]');
    expect(h.document.activeElement).toBe(items[0]);
    await h.key(items[0]!, 'ArrowDown');
    expect(h.document.activeElement).toBe(items[1]);
    await h.key(items[1]!, 'ArrowUp');
    await h.key(items[0]!, 'ArrowUp');
    expect(h.document.activeElement).toBe(items[4]);
    await h.key(items[4]!, 'Escape');
    expect(h.query('[role="menuitemradio"]')).toBeNull();
    expect(h.document.activeElement).toBe(h.query('[data-filter-menu]'));
    await open(h);
    await h.click('.search-input');
    expect(h.query('[role="menuitemradio"]')).toBeNull();
  });
});

describe('attention line', () => {
  it('reads "N need you · M blocked" on All and applies Needs attention when clicked', async () => {
    const h = await mount(withCounts(fixture('all-sections'), { input: 2, failed: 1 }));
    const line = h.query('[data-attention]')!;
    expect(text(line)).toBe('2 need you · 1 blocked');
    await h.click(line);
    expect(sent(h).map((m) => (m as { facet?: string }).facet)).toEqual(['all', 'input', 'failed']);
  });

  it('is hidden when both counts are zero and when a preset is active', async () => {
    expect(h0(await mount(withCounts(fixture('all-sections'), { input: 0, failed: 0 })))).toBeNull();
    expect(h0(await mount({ ...withCounts(fixture('all-sections'), { input: 2, failed: 1 }), facets: ['running'] }))).toBeNull();
  });
  const h0 = (h: RenderedSidebar) => h.query('[data-attention]');
});

describe('archived planning sessions', () => {
  const archivedState = (): SidebarState => ({
    ...fixture('empty'),
    planning: [fixturePlanningRow(1), fixturePlanningRow(77, { title: 'Old plan', status: 'archived' })],
  });

  it('are hidden until the Planning header toggle is pressed', async () => {
    const h = await mount(archivedState());
    expect(h.query('[data-node="s77"]')).toBeNull();
    expect(text(h.query('[data-pane="planning"] .pane-count'))).toBe('1');
    const toggle = h.query('[data-show-archived]')!;
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    await h.click(toggle);
    expect(h.query('[data-show-archived]')!.getAttribute('aria-pressed')).toBe('true');
    expect(h.query('[data-node="s77"]')).not.toBeNull();
    expect(text(h.query('[data-pane="planning"] .pane-count'))).toBe('2');
    expect((h.handle.state as { view: { showArchivedPlans: boolean } }).view.showArchivedPlans).toBe(true);
  });

  it('has no toggle when nothing is archived', async () => {
    const h = await mount({ ...fixture('empty'), planning: [fixturePlanningRow(1)] });
    expect(h.query('[data-show-archived]')).toBeNull();
  });

  it('presets do not touch Planning', async () => {
    const h = await mount({ ...archivedState(), facets: ['done'] });
    expect(h.query('[data-node="s1"]')).not.toBeNull();
  });
});

describe('accepted drafts', () => {
  const pending = fixtureDraft({ id: 11, title: 'Pending one', status: 'pending', ticketId: null, dependsOn: [] });
  const acc1 = fixtureDraft({ id: 12, title: 'Shipped alpha', status: 'accepted', ticketId: 5, dependsOn: [] });
  const acc2 = fixtureDraft({ id: 13, title: 'Shipped beta', status: 'accepted', ticketId: 6, dependsOn: [] });
  const state = (filter = ''): SidebarState => ({ ...fixture('empty'), filter, planning: [fixturePlanningRow(3, { proposals: [pending, acc1, acc2] })] });

  it('keeps pending drafts visible and hides accepted ones behind an "N accepted" toggle', async () => {
    const h = await mount(state());
    expect(h.query('[data-node="d11"]')).not.toBeNull();
    expect(h.query('[data-node="d12"]')).toBeNull();
    const toggle = h.query('[data-node="s3"] .pt-row [data-accepted-toggle]')!;
    expect(text(toggle)).toBe('2 accepted ▸');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    await h.click(toggle);
    const open = h.query('[data-node="s3"] [data-accepted-toggle]')!;
    expect(text(open)).toBe('2 accepted ▾');
    expect(open.getAttribute('aria-expanded')).toBe('true');
    expect(h.queryAll('[data-node^="d"]').map((n) => n.getAttribute('data-node'))).toEqual(['d11', 'd12', 'd13']);
  });

  it('a search that matches an accepted draft reveals its session accepted drafts and opens it', async () => {
    const h = await mount(state('alpha'));
    expect(h.query('[data-node="d12"]')).not.toBeNull();
    expect(h.query('[data-accepted-toggle]')!.getAttribute('aria-expanded')).toBe('true');
    const miss = await mount(state('zzz'));
    expect(miss.query('[data-node="d12"]')).toBeNull();
  });

  it('a session with only accepted drafts shows the toggle and no pending rows', async () => {
    const h = await mount({ ...fixture('empty'), planning: [fixturePlanningRow(4, { proposals: [acc1] })] });
    expect(text(h.query('[data-accepted-toggle]'))).toBe('1 accepted ▸');
    expect(h.query('[data-node="d12"]')).toBeNull();
  });

  it('the toggle is a labelled keyboard-reachable button', async () => {
    const h = await mount(state());
    const t = h.query<HTMLButtonElement>('[data-accepted-toggle]')!;
    expect(t.tagName).toBe('BUTTON');
    expect(t.getAttribute('aria-label')).toBe('Show 2 accepted drafts');
  });
});
