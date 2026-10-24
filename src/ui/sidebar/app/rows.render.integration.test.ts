// @vitest-environment jsdom
/**
 * Rendered-page tests for the ticket rows, the toolbar, the context window, the
 * history disclosure and the search box — what the sidebar document shows and
 * posts, driven through the real chain-mounted bundle. (The Planning tree has its
 * own file; the fixture snapshots live in `sidebar.render.integration.test.ts`.)
 */
import { afterAll, describe, expect, it } from 'vitest';
import { sidebarRenderFixtures } from '../renderFixtures.js';
import type { SidebarState, TicketRow } from '../state.js';
import { closeSidebarRealm, renderSidebarApp, type RenderedSidebar } from './renderSidebarApp.js';

afterAll(closeSidebarRealm);

const fixture = (scenario: string): SidebarState => sidebarRenderFixtures().find((f) => f.scenario === scenario)!.state;
const base = fixture('all-sections');
const row = (i: number, over: Partial<TicketRow> = {}): TicketRow => ({
  ...base.sections.current[0]!,
  ticketId: 910000 + i,
  idLabel: `T${910000 + i}`,
  label: `ROW-${i}`,
  ...over,
});
const stateWith = (sections: Partial<SidebarState['sections']>, over: Partial<SidebarState> = {}): SidebarState => ({
  ...fixture('empty'),
  ...over,
  sections: { current: [], awaitingReview: [], recentlyDone: [], olderDone: [], ...sections },
});
async function mount(state: SidebarState): Promise<RenderedSidebar> {
  const h = await renderSidebarApp();
  await h.receive({ type: 'state', state });
  return h;
}
const text = (e: Element | null | undefined) => e?.textContent ?? '';

describe('ticket row', () => {
  it('states the stage in a chip coloured by the shared stage token, with the full phrase as its tooltip', async () => {
    const h = await mount(stateWith({ current: [row(1, { stageLabel: 'Implementing', stageChip: 'impl', stageClass: 'stg-impl' })] }));
    const chip = h.query('.ticket .row .stage')!;
    expect(chip.classList.contains('stg-impl')).toBe(true);
    expect(text(chip)).toBe('impl');
    expect(chip.getAttribute('title')).toBe('Implementing');
  });

  it('falls back to the phrase and a neutral class for a pre-upgrade row with no chip fields', async () => {
    const legacy = row(1, { stageLabel: '', stageChip: '', stageClass: '', description: 'scope (pending)' });
    const h = await mount(stateWith({ current: [legacy] }));
    const chip = h.query('.ticket .stage')!;
    expect(chip.classList.contains('stg-unknown')).toBe(true);
    expect(text(chip)).toBe('scope (pending)');
  });

  it('reads Queued / Starting for an autostart sub-task, in place of the stage', async () => {
    const h = await mount(stateWith({ current: [row(1, { autostart: 'queued' }), row(2, { autostart: 'starting' })] }));
    expect(h.queryAll('.ticket .stage').map(text)).toEqual(['Queued', 'Starting']);
  });

  it('does NOT repeat the stage as a rail — the collapsed chip already states it', async () => {
    const h = await mount(base);
    expect(h.queryAll('.rail')).toHaveLength(0);
  });

  it('tints the karst mark by the status glyph and names the state for assistive tech (UI-R28)', async () => {
    const h = await mount(stateWith({ current: [row(1, { glyph: 'amber' })] }));
    const glyph = h.query('.ticket .glyph')!;
    expect(glyph.classList.contains('g-amber')).toBe(true);
    expect(glyph.getAttribute('role')).toBe('img');
    expect(glyph.getAttribute('aria-label')).toBe('Needs you');
  });

  it('puts the check-in-ring on completed rows, with no stage pill, and the age only on Recently done', async () => {
    const at = new Date(Date.now() - 5 * 60_000).toISOString();
    const h = await mount(stateWith({ recentlyDone: [row(1, { glyph: 'green', lastActiveAt: at })], olderDone: [row(2, { glyph: 'green' })] }));
    await h.click('[data-history]');
    const rows = h.queryAll('.ticket');
    expect(rows.every((r) => r.classList.contains('done'))).toBe(true);
    expect(h.queryAll('.ticket .stage')).toHaveLength(0);
    expect(h.queryAll('.ticket .glyph.chk')).toHaveLength(2);
    expect(h.queryAll('.ticket .time').map(text)).toEqual(['5m ago']);
    expect(h.query('.histlist .ticket')!.classList.contains('older')).toBe(true);
  });

  it('shows a Blocked-by chip, a follow-up marker and the active-row mark', async () => {
    const h = await mount(stateWith({ current: [row(1, { blockedBy: ['A-1', 'B-2'], parentKey: 'PAR-1', isActive: true })] }));
    expect(text(h.query('.ticket .k-chip'))).toBe('Blocked by A-1, B-2');
    expect(text(h.query('.parentref'))).toBe('↳ PAR-1');
    expect(h.query('.ticket')!.classList.contains('active')).toBe(true);
  });

  it('renders a blocker line ONLY on failure (reason + attempt), never the plain status', async () => {
    const h = await mount(base);
    const warns = h.queryAll('.nextact.warn');
    expect(warns.map(text)).toEqual(['⚠ gate failedattempt 2']);
    expect(text(warns[0]!.querySelector('.att'))).toBe('attempt 2');
    const none = await mount(stateWith({ current: [row(1, { blocker: { reason: null, attempt: 0 } }), row(2, { blocker: null })] }));
    expect(none.queryAll('.nextact')).toHaveLength(0);
    const reasonless = await mount(stateWith({ current: [row(1, { blocker: { reason: null, attempt: 3 } })] }));
    expect(text(reasonless.query('.nextact'))).toBe('⚠ attempt 3');
  });

  it('indents nested rows by depth, clamped to the writer depth, and paints one aria-hidden guide per slot', async () => {
    const deep = row(1, { subtaskDepth: 9, subtaskGuides: [true, false, true, true], subtaskIsLast: false });
    const last = row(2, { subtaskDepth: 2, subtaskGuides: [false, false], subtaskIsLast: true });
    const h = await mount(stateWith({ current: [deep, last, row(3)] }));
    const tickets = h.queryAll('.ticket');
    expect(tickets[0]!.classList.contains('nest4')).toBe(true);
    expect(tickets[0]!.className).not.toMatch(/nest[5-9]/);
    expect(tickets[1]!.classList.contains('nest2')).toBe(true);
    expect(tickets[2]!.className).not.toMatch(/nest/);
    expect(tickets[2]!.querySelector('.guides')).toBeNull();
    const guides = tickets[0]!.querySelector('.guides')!;
    expect(guides.getAttribute('aria-hidden')).toBe('true');
    expect([...guides.children].map((g) => g.className)).toEqual(['guide guide--line', 'guide guide--off', 'guide guide--line', 'guide guide--tee']);
    expect([...tickets[1]!.querySelector('.guides')!.children].map((g) => g.className)).toEqual(['guide guide--off', 'guide guide--elbow']);
  });

  it('shows ⊂ for an orphan sub-task with a parent key and a tooltip naming the relation', async () => {
    const h = await mount(stateWith({ current: [row(1, { subtaskParentKey: 'GONE-1', subtaskDepth: 0 })] }));
    const ref = h.query('.subtaskref')!;
    expect(text(ref)).toBe('⊂ GONE-1');
    expect(ref.getAttribute('title')).toBe('Sub-task of GONE-1');
  });

  it('gives the sub-tree collapse control its own glyphs, never the row chevron (ICONS-02)', async () => {
    const h = await mount(fixture('subtasks'));
    const win = h.handle.window as unknown as { karstIcon(name: string, size: number): string };
    const paths = (name: string) => {
      const tmp = h.document.createElement('div');
      tmp.innerHTML = win.karstIcon(name, 13);
      return tmp.querySelector('svg')!.innerHTML;
    };
    const glyph = (el: Element) => el.querySelector('svg')!.innerHTML;
    const toggle = () => h.query('[data-collapse="900001"]')!;
    expect(glyph(toggle())).toBe(paths('list-tree'));
    expect(glyph(toggle())).not.toBe(glyph(h.query('.chev')!));
    expect(toggle().getAttribute('aria-label')).toBe('Hide 1 nested sub-task');
    await h.click(toggle());
    expect(glyph(toggle())).toBe(paths('layout-list'));
    expect(toggle().getAttribute('aria-label')).toBe('Show 1 nested sub-task');
    expect(h.posted.filter((m) => m.type !== 'request-state')).toEqual([]);
  });

  it('expands and collapses a row on its chevron without posting, pruning the choice when the ticket goes away', async () => {
    const r = row(1);
    const h = await mount(stateWith({ current: [r] }));
    const chev = () => h.query('[data-toggle="910001"]')!;
    expect(chev().getAttribute('aria-expanded')).toBe('false');
    expect(chev().getAttribute('aria-label')).toBe('Expand ticket details');
    await h.click(chev());
    expect(chev().getAttribute('aria-expanded')).toBe('true');
    expect(h.query('.ticket')!.classList.contains('open')).toBe(true);
    expect(h.queryAll('.rowacts')).toHaveLength(0);
    await h.receive({ type: 'state', state: stateWith({ current: [row(2)] }) });
    await h.receive({ type: 'state', state: stateWith({ current: [r] }) });
    expect(chev().getAttribute('aria-expanded')).toBe('false');
    expect(h.posted.filter((m) => m.type !== 'request-state')).toEqual([]);
  });
});

describe('expanded mini-dashboard', () => {
  const peeked = (peek: Partial<NonNullable<TicketRow['peek']>>, over: Partial<TicketRow> = {}) =>
    row(1, { peek: { title: 'Gate running', detail: 'lint', next: null, ...peek }, ...over });

  it('renders the host summary: title, detail, and the Spin / Session / Dashboard tools', async () => {
    const h = await mount(stateWith({ current: [peeked({}, { sessionAction: { kind: 'continue', label: 'Continue', detail: '' } as never })] }));
    expect(text(h.query('.peek-title'))).toBe('Gate running');
    expect(text(h.query('.peek-detail'))).toBe('lint');
    expect(h.queryAll('.peek-tools [data-act]').map((b) => b.getAttribute('data-act'))).toEqual(['spin', 'open-session', 'open-dashboard']);
    expect(h.query('.peek-tools [data-act="open-session"]')!.getAttribute('aria-label')).toBe('Continue session');
    expect(h.queryAll('.peek-actions')).toHaveLength(0);
  });

  it('keeps the labeled next action and posts it with the right payload', async () => {
    for (const [kind, extra] of [['open-session', {}], ['create-follow-up', {}], ['send-ci-failure', {}], ['resolve-conflicts', { repo: 'web' }]] as const) {
      const h = await mount(stateWith({ current: [peeked({ next: { kind, label: `Do ${kind}`, ...extra } as never })] }));
      const cta = h.query<HTMLButtonElement>('.peek-actions .k-btn--primary')!;
      expect(text(cta)).toBe(`Do ${kind}`);
      await h.click(cta);
      expect(h.posted.at(-1)).toMatchObject({ type: kind, ticketId: 910001, ...extra });
    }
  });

  it('draws gate progress, the agent identity and the per-repo landing state when the host provides them', async () => {
    const h = await mount(stateWith({ current: [peeked({
      progress: { passed: 1, total: 3 },
      agent: { provider: 'claude', model: 'opus' },
      repos: [{ repo: 'api', number: 12, state: 'ready' }, { repo: 'web', number: null, state: 'conflict' }],
    })] }));
    const bar = h.query('.peek-progress')!;
    expect(bar.getAttribute('role')).toBe('progressbar');
    expect([bar.getAttribute('aria-valuenow'), bar.getAttribute('aria-valuemin'), bar.getAttribute('aria-valuemax')]).toEqual(['1', '0', '3']);
    expect(bar.querySelector('span')!.getAttribute('style')).toContain('33%');
    expect(h.query('.peek-agent .agent-identity.compact')!.getAttribute('data-provider')).toBe('claude');
    expect(text(h.query('.peek-agent .agent-identity-model'))).toBe('opus');
    expect(h.queryAll('.peek-repo').map(text)).toEqual(['#12api✓ Ready', 'web! Conflicts']);
    expect(h.query('.peek-repo-state.conflict')).not.toBeNull();
  });

  it('draws no progress bar for an empty gate, and no agent line without a provider', async () => {
    const h = await mount(stateWith({ current: [peeked({ progress: { passed: 0, total: 0 }, agent: { provider: '', model: null } })] }));
    expect(h.queryAll('.peek-progress')).toHaveLength(0);
    expect(h.queryAll('.peek-agent')).toHaveLength(0);
  });

  it('prints the meta line without empty tokens, and no meta element when there is nothing to say', async () => {
    const full = peeked({}, {
      model: 'opus',
      worktrees: [{ repo: '/x/api', repoDisplay: 'api' }] as never,
      servers: [{ port: 3000 }] as never,
      prs: [{ repo: 'api', number: 12, url: null, status: 'open' }],
    });
    const h = await mount(stateWith({ current: [full] }));
    expect(text(h.query('.meta'))).toBe('opus · api · :3000 · PR #12');
    const bare = await mount(stateWith({ current: [peeked({})] }));
    expect(bare.queryAll('.meta')).toHaveLength(0);
  });

  it('offers Restore / Delete (labeled) on an archived row instead of the live tools, and posts them', async () => {
    const h = await mount(stateWith({}, { facets: ['archived'], rows: [row(1, { archived: true })] }));
    expect(h.queryAll('.peek')).toHaveLength(0);
    expect(h.queryAll('.rowopen')[0]!.tagName).toBe('SPAN');
    expect(h.queryAll('.rowacts [data-act]').map((b) => b.getAttribute('data-act'))).toEqual(['unarchive', 'delete']);
    await h.click('.actions [data-act="unarchive"]');
    await h.click('.actions [data-act="delete"]');
    expect(h.posted.filter((m) => m.type === 'unarchive' || m.type === 'delete')).toEqual([
      expect.objectContaining({ type: 'unarchive', ticketId: 910001 }),
      expect.objectContaining({ type: 'delete', ticketId: 910001 }),
    ]);
  });
});

describe('posting controls', () => {
  it('open the ticket dashboard from the row, tracked as a request that goes pending and settles on the host answer', async () => {
    const h = await mount(stateWith({ current: [row(1)] }));
    const open = h.query<HTMLButtonElement>('.rowopen')!;
    await h.click(open);
    const sent = h.posted.find((m) => m.type === 'open-ticket') as { requestId: string; ticketId: number };
    expect(sent.ticketId).toBe(910001);
    expect(sent.requestId).toBeTruthy();
    expect(open.getAttribute('aria-busy')).toBe('true');
    expect(open.disabled).toBe(true);
    await h.click(open);
    expect(h.posted.filter((m) => m.type === 'open-ticket')).toHaveLength(1);
    await h.receive({ type: 'action-result', requestId: sent.requestId, ok: true });
    expect(open.hasAttribute('aria-busy')).toBe(false);
    expect(open.disabled).toBe(false);
  });

  it('report a failed action through the live region', async () => {
    const h = await mount(stateWith({ current: [row(1)] }));
    await h.click('.rowopen');
    const sent = h.posted.find((m) => m.type === 'open-ticket') as { requestId: string };
    await h.receive({ type: 'action-result', requestId: sent.requestId, ok: false, message: 'could not open' });
    expect(text(h.query('[aria-live="polite"]'))).toContain('could not open');
  });

  it('post every toolbar handoff', async () => {
    const h = await mount(base);
    for (const act of ['create', 'plan-create', 'open-resources', 'open-token-usage', 'open-settings']) {
      await h.click(`.toolbar [data-act="${act}"]`);
    }
    expect(h.posted.filter((m) => m.type !== 'request-state').map((m) => m.type)).toEqual([
      'create', 'plan-create', 'open-resources', 'open-token-usage', 'open-settings',
    ]);
    expect(h.queryAll('.toolbar [aria-label]').map((b) => b.getAttribute('aria-label'))).toEqual([
      'Create ticket', 'Start planning session', 'Open resource monitor', 'Open token usage', 'Open settings',
    ]);
  });

  it('offer Create ticket from the empty list', async () => {
    const h = await mount(fixture('empty'));
    expect(text(h.query('.k-empty-title'))).toBe('No tickets yet');
    await h.click('.k-empty [data-act="create"]');
    expect(h.posted.at(-1)).toMatchObject({ type: 'create' });
  });

  it('say why the list is empty for a search, the Done facet and the Archived facet', async () => {
    expect(text((await mount({ ...fixture('empty'), filter: 'zzz' })).query('.k-empty-title'))).toBe('No tickets match');
    expect(text((await mount({ ...fixture('empty'), facets: ['done'] })).query('.k-empty-title'))).toBe('No done tickets');
    expect(text((await mount({ ...fixture('empty'), facets: ['archived'] })).query('.k-empty-title'))).toBe('No archived tickets');
  });
});

describe('context window', () => {
  async function opened() {
    const h = await mount(stateWith({ current: [row(1), row(2)] }));
    const trigger = h.query<HTMLButtonElement>('[data-menu="910001"]')!;
    await h.click(trigger);
    return { h, trigger };
  }
  const items = (h: RenderedSidebar) => h.queryAll('#ctxMenu.open [role="menuitem"]');

  it('opens at the "⋯" trigger with Edit / Create follow-up / Archive and hands focus to the first item', async () => {
    const { h, trigger } = await opened();
    expect(items(h).map((i) => i.getAttribute('data-act'))).toEqual(['edit', 'create-follow-up', 'archive']);
    expect(items(h).map((i) => text(i).trim())).toEqual(['Edit ticket', 'Create follow-up', 'Archive']);
    expect(items(h)[2]!.classList.contains('danger')).toBe(true);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(trigger.getAttribute('aria-haspopup')).toBe('menu');
    expect(h.document.activeElement).toBe(items(h)[0]);
    expect(h.query<HTMLElement>('#ctxMenu')!.style.left).not.toBe('');
  });

  it('closes on a second click of the trigger, returning focus to it', async () => {
    const { h, trigger } = await opened();
    await h.click(trigger);
    expect(h.query('#ctxMenu.open')).toBeNull();
    expect(h.query('#ctxMenu')!.children).toHaveLength(0);
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(h.document.activeElement).toBe(trigger);
  });

  it('closes on Escape returning focus to the trigger, and on an outside click without taking focus', async () => {
    const { h, trigger } = await opened();
    await h.key(h.document.body, 'Escape');
    expect(h.query('#ctxMenu.open')).toBeNull();
    expect(h.document.activeElement).toBe(trigger);
    await h.click(trigger);
    await h.click('.toolbar');
    expect(h.query('#ctxMenu.open')).toBeNull();
  });

  it('moves to another row\'s trigger and rebuilds the items for that ticket', async () => {
    const { h } = await opened();
    await h.click('[data-menu="910002"]');
    expect(h.queryAll('#ctxMenu.open')).toHaveLength(1);
    expect(items(h).map((i) => i.getAttribute('data-id'))).toEqual(['910002', '910002', '910002']);
    expect(h.query('[data-menu="910001"]')!.getAttribute('aria-expanded')).toBe('false');
  });

  it('posts the chosen action for its ticket and closes', async () => {
    const { h } = await opened();
    await h.click('#ctxMenu [data-act="create-follow-up"]');
    expect(h.posted.at(-1)).toMatchObject({ type: 'create-follow-up', ticketId: 910001 });
    expect(h.query('#ctxMenu.open')).toBeNull();
  });

  it('closes on a state push, on a row expand and on a facet click', async () => {
    for (const close of [
      (h: RenderedSidebar) => h.receive({ type: 'state', state: stateWith({ current: [row(1), row(2)] }) }),
      (h: RenderedSidebar) => h.click('[data-toggle="910002"]'),
      (h: RenderedSidebar) => h.click('[data-facet="running"]'),
    ]) {
      const { h } = await opened();
      await close(h);
      expect(h.query('#ctxMenu.open')).toBeNull();
    }
  });
});

describe('Older Completed disclosure', () => {
  const state = (filter = '') => stateWith({ olderDone: [row(1, { glyph: 'green' }), row(2, { glyph: 'green' })] }, { filter });

  it('is collapsed by default, naming the count, and expands on click', async () => {
    const h = await mount(state());
    const toggle = () => h.query('[data-history]')!;
    expect(text(toggle()).trim()).toBe('2 more completed');
    expect(toggle().getAttribute('aria-expanded')).toBe('false');
    expect(toggle().hasAttribute('aria-controls')).toBe(false);
    expect(h.queryAll('.histlist')).toHaveLength(0);
    await h.click(toggle());
    expect(toggle().getAttribute('aria-expanded')).toBe('true');
    expect(toggle().getAttribute('aria-controls')).toBe('histlist');
    expect(h.queryAll('#histlist .ticket')).toHaveLength(2);
  });

  it('auto-reveals for a search match and re-collapses when the search clears — unless the user chose', async () => {
    const h = await mount(state('ROW'));
    expect(h.queryAll('#histlist .ticket')).toHaveLength(2);
    await h.receive({ type: 'state', state: state('') });
    expect(h.queryAll('#histlist')).toHaveLength(0);
    await h.click('[data-history]');
    await h.receive({ type: 'state', state: state('ROW') });
    await h.receive({ type: 'state', state: state('') });
    expect(h.queryAll('#histlist .ticket')).toHaveLength(2);
  });
});

describe('facets and views', () => {
  it('lights the selected chips and shows the host counts', async () => {
    const h = await mount(fixture('multi-facet'));
    const pressed = h.queryAll('[data-facet][aria-pressed="true"]').map((c) => c.getAttribute('data-facet'));
    expect(pressed).toEqual(['running', 'failed']);
    expect(h.queryAll('[data-facet]').map((c) => c.textContent)).toEqual(['All 4', 'In progress 2', 'Needs you 0', 'Blocked 2', 'Done 0', 'Archived 0']);
  });

  it('posts only WHICH chip was clicked', async () => {
    const h = await mount(base);
    await h.click('[data-facet="input"]');
    expect(h.posted.at(-1)).toEqual({ type: 'toggle-facet', facet: 'input' });
  });

  it('renders the Done facet as one newest-first list with a Done header and no history control', async () => {
    const h = await mount(fixture('done-facet'));
    expect(h.queryAll('.sec-name').map(text)).toEqual(['Done']);
    expect(h.queryAll('.ticket.done')).toHaveLength(2);
    expect(h.queryAll('[data-history]')).toHaveLength(0);
  });

  it('keeps the section headers truthful: only sections that render, with their counts', async () => {
    const h = await mount(base);
    expect(h.queryAll('.sec').map((s) => text(s).replace(/\s+/g, ' '))).toEqual([
      'Planning· 2', 'Current· 3', 'Awaiting review· 1', 'Recently done· 1',
    ]);
  });
});

describe('search box', () => {
  it('posts the query once, after a short pause', async () => {
    const h = await mount(base);
    const input = h.query<HTMLInputElement>('#search')!;
    for (const value of ['a', 'au', 'aut']) {
      input.value = value;
      input.dispatchEvent(new h.handle.window.Event('input', { bubbles: true }));
    }
    await h.settle();
    expect(h.posted.filter((m) => m.type === 'set-filter')).toEqual([]);
    await new Promise((r) => setTimeout(r, 260));
    expect(h.posted.filter((m) => m.type === 'set-filter')).toEqual([{ type: 'set-filter', query: 'aut' }]);
  });

  it('follows the host filter: a push that changed it rewrites the box', async () => {
    const h = await mount({ ...base, filter: 'auth' });
    expect(h.query<HTMLInputElement>('#search')!.value).toBe('auth');
    await h.receive({ type: 'state', state: { ...base, filter: '' } });
    expect(h.query<HTMLInputElement>('#search')!.value).toBe('');
  });
});

describe('host feed', () => {
  it('remembers the last snapshot with setState so a re-resolved view repaints at once', async () => {
    const h = await mount(base);
    expect(h.handle.state).toEqual(base);
  });

  it('escapes hostile ticket text — it is text, never markup (UI-R32)', async () => {
    const h = await mount(fixture('hostile'));
    expect(h.queryAll('.list script, .list img')).toHaveLength(0);
    expect(text(h.query('.ticket .name'))).toBe('<script>alert(1)</script>');
    expect(text(h.query('.peek-title'))).toBe('<script>alert(1)</script>');
  });
});
