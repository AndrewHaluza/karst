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
import { ticketRefView } from '../../shared/ticketRefView.js';

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

describe('ticket row priority chip', () => {
  it('names the source in the tooltip and the accessible name for each state', async () => {
    const h = await mount(fixture('priority'));
    const chips = h.queryAll('.ticket .row .k-pri');
    expect(chips.map((c) => c.getAttribute('title'))).toEqual([
      'Urgent · ClickUp',
      'High · set by you',
      'Low · set by you (ClickUp: High)',
    ]);
    expect(chips.map((c) => c.getAttribute('aria-label'))).toEqual(chips.map((c) => c.getAttribute('title')));
  });
});

describe('ticket row', () => {
  it('states the stage in a chip coloured by the shared stage token, with the full phrase as its tooltip', async () => {
    const h = await mount(stateWith({ current: [row(1, { stageLabel: 'Implementing', stageChip: 'impl', stageClass: 'stg-impl' })] }));
    const chip = h.query('.ticket .row .stage')!;
    expect(chip.classList.contains('stg-impl')).toBe(true);
    // The word is drawn by CSS from data-full / data-short (full when wide, the key when narrow).
    expect(chip.getAttribute('data-full')).toBe('Implementation');
    expect(chip.getAttribute('data-short')).toBe('impl');
    expect(chip.getAttribute('aria-label')).toBe('Implementing');
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

  it('shows Waits on with one chip and a +N button, a follow-up marker and the active-row mark', async () => {
    const h = await mount(stateWith({ current: [row(1, { blockedBy: [ticketRefView({ ref: 'A-1' }), ticketRefView({ ref: 'B-2' }), ticketRefView({ ref: 'C-3' })], parentKey: 'PAR-1', isActive: true })] }));
    expect(text(h.query('.ticket .refs-verb'))).toBe('Waits on');
    expect(h.queryAll('.ticket .refs-line .k-ticket-ref').map(text)).toEqual(['A-1']);
    const more = h.query<HTMLButtonElement>('.ticket button.refs-more')!;
    expect(text(more)).toBe('+2');
    expect(more.getAttribute('aria-expanded')).toBe('false');
    expect(text(h.query('.parentref'))).toBe('↳ PAR-1');
    expect(h.query('.ticket')!.classList.contains('active')).toBe(true);
    expect(h.document.body.textContent).not.toMatch(/Blocked by/);
  });

  it('keeps the references outside the row click target, on their own line (UI-R09)', async () => {
    const h = await mount(stateWith({ current: [row(1, { blockedBy: [ticketRefView({ ref: 'A-1' }), ticketRefView({ ref: 'B-2' })] })] }));
    expect(h.query('.ticket .rowopen .k-ticket-ref')).toBeNull();
    expect(h.query('.ticket .rowopen button')).toBeNull();
    expect(h.query('.ticket > .refs')).not.toBeNull();
  });

  it('opens the other chips inline on +N, and Escape closes them and returns focus to +N', async () => {
    const h = await mount(stateWith({ current: [row(1, { blockedBy: [ticketRefView({ ref: 'A-1' }), ticketRefView({ ref: 'B-2' }), ticketRefView({ ref: 'C-3' })] })] }));
    const list = h.query<HTMLElement>('.ticket .refs-list')!;
    expect(list.hidden).toBe(true);
    await h.click('.ticket button.refs-more');
    expect(list.hidden).toBe(false);
    expect(h.query('.ticket button.refs-more')!.getAttribute('aria-expanded')).toBe('true');
    expect(Array.from(list.querySelectorAll('.k-ticket-ref')).map(text)).toEqual(['B-2', 'C-3']);
    const more = h.query<HTMLButtonElement>('.ticket button.refs-more')!;
    more.focus();
    more.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await Promise.resolve();
    expect(h.query('.ticket button.refs-more')!.getAttribute('aria-expanded')).toBe('false');
    expect(h.document.activeElement).toBe(h.query('.ticket button.refs-more'));
  });

  it('closes the inline list on an outside click', async () => {
    const h = await mount(stateWith({ current: [row(1, { blockedBy: [ticketRefView({ ref: 'A-1' }), ticketRefView({ ref: 'B-2' })] })] }));
    await h.click('.ticket button.refs-more');
    expect(h.query('.ticket button.refs-more')!.getAttribute('aria-expanded')).toBe('true');
    h.document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    await Promise.resolve();
    expect(h.query('.ticket button.refs-more')!.getAttribute('aria-expanded')).toBe('false');
  });

  it('renders a single reference with no +N button', async () => {
    const h = await mount(stateWith({ current: [row(1, { blockedBy: [ticketRefView({ ref: 'A-1' })] })] }));
    expect(h.query('.ticket button.refs-more')).toBeNull();
  });

  it('renders a proposal-only reference as a plain chip, never a nested button (UI-R09)', async () => {
    const h = await mount(stateWith({ current: [row(1, { blockedBy: [ticketRefView({ draftId: 94 })] })] }));
    const chip = h.query('.ticket .k-ticket-ref')!;
    expect(chip.tagName).toBe('SPAN');
    expect(chip.querySelector('button')).toBeNull();
    expect(text(chip)).toContain('D94');
  });

  it('renders no separate blocker line: the state word and the gate line carry the failure', async () => {
    const h = await mount(base);
    expect(h.queryAll('.nextact')).toHaveLength(0);
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
    row(1, { peek: { title: 'Gates running', next: null, ...peek }, ...over });

  it('renders the headline and the Session / Pause / More tools', async () => {
    const h = await mount(stateWith({ current: [peeked({ since: { at: '2026-01-01T00:00:00Z', kind: 'ago' }, attempt: 2 }, { sessionAction: { kind: 'continue', label: 'Continue', detail: '' } as never })] }));
    expect(text(h.query('.peek-title'))).toBe('Gates running');
    expect(text(h.query('.peek-attempt'))).toBe('attempt 2');
    expect(h.query('.peek-age')).not.toBeNull();
    expect(h.queryAll('.peek-tools [data-act]').map((b) => b.getAttribute('data-act'))).toEqual(['open-session', 'pause-ticket']);
    expect(h.query('.peek-tools [data-act="open-session"]')!.getAttribute('aria-label')).toBe('Continue session');
    expect(h.query('.peek-tools [data-menu]')).not.toBeNull();
  });

  it('shows Resume as a pressed toggle on a paused row, and no Pause on a done row', async () => {
    const paused = await mount(stateWith({ current: [peeked({}, { paused: true })] }));
    const btn = paused.query('.peek-tools .pausebtn')!;
    expect(btn.getAttribute('aria-pressed')).toBe('true');
    expect(btn.getAttribute('data-act')).toBe('unpause-ticket');
    const done = await mount(stateWith({ current: [peeked({}, { stageCurrent: 'done' })] }));
    expect(done.queryAll('.pausebtn')).toHaveLength(0);
  });

  it('puts the amber ring on the Session tool for an open-session need, with no button in the strip', async () => {
    const h = await mount(stateWith({ current: [peeked({ needs: { detail: 'the agent asked you something', action: 'Open session', cta: { kind: 'open-session' } } })] }));
    expect(h.query('.peek-tools [data-act="open-session"]')!.classList.contains('needs-ring')).toBe(true);
    expect(text(h.query('.peek-strip-text'))).toBe('the agent asked you something');
    expect(h.queryAll('.peek-strip button')).toHaveLength(0);
  });

  it('posts each rail cta with the right payload', async () => {
    const cases = [
      [{ kind: 'ship-confirm' }, 'ship-ticket', {}, 'Confirm ship'],
      [{ kind: 'retry-ship' }, 'retry-ship', {}, 'Retry ship'],
      [{ kind: 'merge', repo: 'api' }, 'merge-pr', { repo: 'api' }, 'Merge'],
      [{ kind: 'resolve-conflicts', repo: 'web' }, 'resolve-conflicts', { repo: 'web' }, 'Resolve'],
      [{ kind: 'merge-panel' }, 'open-dashboard', {}, 'Open dashboard'],
    ] as const;
    for (const [cta, type, extra, label] of cases) {
      const h = await mount(stateWith({ current: [peeked({ needs: { detail: 'why', action: label, cta } as never })] }));
      const btn = h.query<HTMLButtonElement>('.peek-strip .k-btn--primary')!;
      expect(text(btn)).toBe(label);
      await h.click(btn);
      expect(h.posted.at(-1)).toMatchObject({ type, ticketId: 910001, ...extra });
    }
  });

  it('keeps the peek-only strips: Send CI failure, and Create follow-up on the where line', async () => {
    const ci = await mount(stateWith({ current: [peeked({ next: { kind: 'send-ci-failure', label: 'Send CI failure to agent' } })] }));
    await ci.click('.peek-strip .k-btn--primary');
    expect(ci.posted.at(-1)).toMatchObject({ type: 'send-ci-failure', ticketId: 910001 });
    const fu = await mount(stateWith({ current: [peeked({ next: { kind: 'create-follow-up', label: 'Create follow-up' } })] }));
    expect(fu.queryAll('.peek-strip')).toHaveLength(0);
    await fu.click('.peek-where .peek-followup');
    expect(fu.posted.at(-1)).toMatchObject({ type: 'create-follow-up', ticketId: 910001 });
  });

  it('draws the gate line, the PR line and the agent line when the host provides them', async () => {
    const h = await mount(stateWith({ current: [peeked({
      gates: { text: '3 passed · 2 failed: lint, test', tone: 'failed' },
      agent: { provider: 'claude', model: 'opus', activity: 'working', activeAt: null },
      repos: [{ repo: 'api', number: 12, state: 'ready' }, { repo: 'web', number: null, state: 'conflict' }],
      pausedNote: 'No stage starts until you resume',
    })] }));
    expect(text(h.query('.peek-gates.failed'))).toBe('3 passed · 2 failed: lint, test');
    expect(h.query('.peek-agent .agent-identity.compact')!.getAttribute('data-provider')).toBe('claude');
    expect(text(h.query('.peek-agent-tail'))).toBe(' · working');
    expect(h.queryAll('.peek-repo').map(text)).toEqual(['#12 api · ready', 'web · conflict']);
    expect(text(h.query('.peek-paused'))).toBe('No stage starts until you resume');
  });

  it('draws the graph role line for a graph ticket, with the rung that supplied each role (T1266)', async () => {
    const h = await mount(stateWith({ current: [peeked({}, {
      graphRoles: [
        { role: 'expert', text: 'codex · gpt-5.6-sol', source: 'preset' },
        { role: 'worker', text: 'claude · claude-sonnet-5 · low', source: 'approach' },
      ],
    })] }));
    const rows = h.queryAll('.peek-graph-role');
    expect(rows.map(text)).toEqual(['expert codex · gpt-5.6-sol (preset)', 'worker claude · claude-sonnet-5 · low (approach)']);
    const none = await mount(stateWith({ current: [peeked({})] }));
    expect(none.queryAll('.peek-graph-role')).toHaveLength(0);
  });

  it('draws no agent line without a provider and no fact lines for an old-shape peek', async () => {
    const h = await mount(stateWith({ current: [peeked({ agent: { provider: '', model: null } })] }));
    expect(h.queryAll('.peek-agentline')).toHaveLength(0);
    expect(h.queryAll('.peek-gates, .peek-strip, .peek-paused')).toHaveLength(0);
    // A snapshot restored from before this layout has only `title` and `next`.
    const old = await mount(stateWith({ current: [row(1, { peek: { title: 'Old state', next: null } })] }));
    expect(text(old.query('.peek-title'))).toBe('Old state');
  });

  it('prints the where line from the repos and ports, with no line when there is nothing to say', async () => {
    const full = peeked({}, {
      worktrees: [{ repo: '/x/api', repoDisplay: 'api' }, { repo: '/x/web', repoDisplay: 'web' }] as never,
      servers: [{ port: 3000 }] as never,
    });
    const h = await mount(stateWith({ current: [full] }));
    expect(text(h.query('.peek-where-text'))).toBe('api + web · :3000');
    const bare = await mount(stateWith({ current: [peeked({})] }));
    expect(bare.queryAll('.peek-where')).toHaveLength(0);
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
    for (const act of ['open-resources', 'open-token-usage', 'open-settings']) {
      await h.click(`.toolbar [data-act="${act}"]`);
    }
    expect(h.posted.filter((m) => m.type !== 'request-state').map((m) => m.type)).toEqual([
      'open-resources', 'open-token-usage', 'open-settings',
    ]);
    expect(h.queryAll('.toolbar [aria-label]').map((b) => b.getAttribute('aria-label'))).toEqual([
      'Open resource monitor', 'Open token usage', 'Open settings',
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
    expect(items(h).map((i) => i.getAttribute('data-act'))).toEqual(['edit', 'spin', 'create-follow-up', 'archive', 'cloud-session-add']);
    expect(items(h).map((i) => text(i).trim())).toEqual(['Edit ticket', 'Start servers', 'Create follow-up', 'Archive', 'Link cloud session…']);
    expect(items(h)[3]!.classList.contains('danger')).toBe(true);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(trigger.getAttribute('aria-haspopup')).toBe('menu');
    expect(h.document.activeElement).toBe(items(h)[0]);
    expect(h.query<HTMLElement>('#ctxMenu')!.style.left).not.toBe('');
  });

  it('offers each flagged action in order, a divider before Archive, and Start servers in place of Pause/Resume', async () => {
    const h = await mount(stateWith({ current: [{ ...row(1), paused: true, canDetach: true, canClose: true, canReopen: true }] }));
    await h.click(h.query<HTMLButtonElement>('[data-menu="910001"]')!);
    expect(items(h).map((i) => i.getAttribute('data-act'))).toEqual([
      'edit', 'spin', 'create-follow-up', 'detach-subtask', 'close-ticket', 'reopen-ticket', 'archive', 'cloud-session-add',
    ]);
    expect(items(h)[4]!.classList.contains('danger')).toBe(true);
    expect(items(h)[6]!.previousElementSibling!.getAttribute('role')).toBe('separator');
    await h.click(items(h)[3]!);
    expect(h.posted.at(-1)).toMatchObject({ type: 'detach-subtask', ticketId: 910001 });
  });

  it.each([
    ['canDetach', 'detach-subtask'],
    ['canClose', 'close-ticket'],
    ['canReopen', 'reopen-ticket'],
  ] as const)('hides %s item when the flag is false and shows it when true', async (flag, act) => {
    const on = await mount(stateWith({ current: [{ ...row(1), [flag]: true }] }));
    await on.click(on.query<HTMLButtonElement>('[data-menu="910001"]')!);
    expect(items(on).map((i) => i.getAttribute('data-act'))).toContain(act);
    const off = await mount(stateWith({ current: [{ ...row(1), [flag]: false }] }));
    await off.click(off.query<HTMLButtonElement>('[data-menu="910001"]')!);
    expect(items(off).map((i) => i.getAttribute('data-act'))).not.toContain(act);
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
    expect(items(h).map((i) => i.getAttribute('data-id'))).toEqual(['910002', '910002', '910002', '910002', '910002']);
    expect(h.query('[data-menu="910001"]')!.getAttribute('aria-expanded')).toBe('false');
  });

  it('posts the chosen action for its ticket and closes', async () => {
    const { h } = await opened();
    await h.click('#ctxMenu [data-act="create-follow-up"]');
    expect(h.posted.at(-1)).toMatchObject({ type: 'create-follow-up', ticketId: 910001 });
    expect(h.query('#ctxMenu.open')).toBeNull();
  });

  it('closes on a state push, on a row expand and on a preset choice', async () => {
    for (const close of [
      (h: RenderedSidebar) => h.receive({ type: 'state', state: stateWith({ current: [row(1), row(2)] }) }),
      (h: RenderedSidebar) => h.click('[data-toggle="910002"]'),
      async (h: RenderedSidebar) => {
        await h.click('[data-filter-menu]');
        await h.click('[data-preset="running"]');
      },
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
  it('shows no checked preset (and the dot) for a selection no preset names', async () => {
    const h = await mount(fixture('multi-facet'));
    expect(h.query('[data-filter-dot]')).not.toBeNull();
    expect(h.query('[data-filter-menu]')!.getAttribute('aria-label')).toBe('Filter tickets: custom');
    await h.click('[data-filter-menu]');
    expect(h.queryAll('[role="menuitemradio"][aria-checked="true"]')).toHaveLength(0);
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
      'Current· 3', 'Awaiting review· 1', 'Recently done· 1',
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
    expect(h.handle.state).toEqual({ ...base, view: { collapsed: { planning: false, queue: true, tickets: false }, showArchivedPlans: false, queueFilters: { kinds: [], sessions: [], levels: [], blocked: [], chain: null } } });
  });

  it('escapes hostile ticket text — it is text, never markup (UI-R32)', async () => {
    const h = await mount(fixture('hostile'));
    expect(h.queryAll('.list script, .list img')).toHaveLength(0);
    expect(text(h.query('.ticket .name'))).toBe('<script>alert(1)</script>');
    expect(text(h.query('.peek-title'))).toBe('<script>alert(1)</script>');
  });
});
