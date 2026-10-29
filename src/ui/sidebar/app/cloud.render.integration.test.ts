// @vitest-environment jsdom
/**
 * Rendered-page tests for cloud agent sessions in the Tickets pane (arch:CLOUD-01):
 * the icon link on a ticket row, the unlinked-session rows, the link / unlink
 * menus and what they post.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { sidebarRenderFixtures } from '../renderFixtures.js';
import type { CloudSessionChip, SidebarState, TicketRow, UnlinkedCloudSession } from '../state.js';
import { closeSidebarRealm, renderSidebarApp } from './renderSidebarApp.js';

afterAll(closeSidebarRealm);

const fixture = (scenario: string): SidebarState => sidebarRenderFixtures().find((f) => f.scenario === scenario)!.state;
const base = fixture('all-sections');
const URL_A = 'https://claude.ai/code/session_a';
const URL_B = 'https://claude.ai/code/session_b';
const chip = (
  url: string,
  linkSource: CloudSessionChip['linkSource'] = 'pr',
  over: Partial<CloudSessionChip> = {},
): CloudSessionChip => ({
  provider: 'claude',
  label: 'Claude Code on the web',
  url,
  linkSource,
  firstSeen: '2026-10-29T10:00:00.000Z',
  ...over,
});
const unlinked = (id: number, url: string, over: Partial<UnlinkedCloudSession> = {}): UnlinkedCloudSession => ({
  id, provider: 'claude', label: 'Claude Code on the web', url, proposalId: null, ...over,
});
const row = (i: number, over: Partial<TicketRow> = {}): TicketRow => ({
  ...base.sections.current[0]!, ticketId: 920000 + i, idLabel: `T${920000 + i}`, label: `ROW-${i}`, ...over,
});
const stateWith = (current: TicketRow[], cloud: UnlinkedCloudSession[] = [], over: Partial<SidebarState> = {}): SidebarState => ({
  ...fixture('empty'),
  ...over,
  sections: { current, awaitingReview: [], recentlyDone: [], olderDone: [] },
  unlinkedCloudSessions: cloud,
});
async function mount(state: SidebarState) {
  const h = await renderSidebarApp();
  await h.receive({ type: 'state', state });
  return h;
}

describe('cloud session icon on a ticket row', () => {
  it('renders one direct link for a single session, posting cloud-session-open', async () => {
    const h = await mount(stateWith([row(1, { cloudSessions: [chip(URL_A)] })]));
    const btns = h.queryAll<HTMLButtonElement>('.ticket .cloudlinks button');
    expect(btns).toHaveLength(1);
    expect(btns[0]!.getAttribute('aria-label')).toBe('Open in Claude Code on the web');
    expect(btns[0]!.getAttribute('title')).toBe('Open in Claude Code on the web');
    expect(btns[0]!.getAttribute('aria-haspopup')).toBeNull();
    expect(btns[0]!.querySelector('svg')).not.toBeNull();
    expect(btns[0]!.closest('.rowopen')).toBeNull();
    await h.click(btns[0]!);
    expect(h.posted.at(-1)).toMatchObject({ type: 'cloud-session-open', url: URL_A });
  });

  it('renders one icon for multiple sessions of the same provider with a menu posting each URL', async () => {
    const now = Date.now();
    const h = await mount(
      stateWith([
        row(1, {
          cloudSessions: [
            chip(URL_B, 'branch', { firstSeen: new Date(now - 5 * 60_000).toISOString() }),
            chip(URL_A, 'pr', { firstSeen: new Date(now - 60 * 60_000).toISOString() }),
          ],
        }),
      ]),
    );
    const btns = h.queryAll<HTMLButtonElement>('.ticket .cloudlinks button');
    expect(btns).toHaveLength(1);
    expect(btns[0]!.getAttribute('aria-label')).toBe('Open in Claude Code on the web · 2 sessions');
    expect(btns[0]!.getAttribute('title')).toBe('Open in Claude Code on the web · 2 sessions');
    expect(btns[0]!.getAttribute('aria-haspopup')).toBe('menu');
    expect(h.query<HTMLElement>('.ticket .row')!.style.getPropertyValue('--cloud-n')).toBe('1');

    await h.click(btns[0]!);
    const items = h.queryAll<HTMLButtonElement>('#ctxMenu .ctxitem');
    expect(items).toHaveLength(2);
    expect(items[0]!.textContent?.trim()).toBe('5m ago (branch)');
    expect(items[1]!.textContent?.trim()).toBe('1h ago (pr)');

    await h.click(items[0]!);
    expect(h.posted.at(-1)).toMatchObject({ type: 'cloud-session-open', url: URL_B });

    await h.click(btns[0]!);
    await h.click(h.queryAll<HTMLButtonElement>('#ctxMenu .ctxitem')[1]!);
    expect(h.posted.at(-1)).toMatchObject({ type: 'cloud-session-open', url: URL_A });
  });

  it('renders two icons for two different providers', async () => {
    const h = await mount(
      stateWith([
        row(1, {
          cloudSessions: [
            chip(URL_A, 'pr'),
            chip('https://chatgpt.com/session_1', 'pr', { provider: 'chatgpt', label: 'ChatGPT' }),
          ],
        }),
      ]),
    );
    const btns = h.queryAll<HTMLButtonElement>('.ticket .cloudlinks button');
    expect(btns).toHaveLength(2);
    expect(h.query<HTMLElement>('.ticket .row')!.style.getPropertyValue('--cloud-n')).toBe('2');
  });

  it('renders nothing for a ticket without sessions', async () => {
    const h = await mount(stateWith([row(1)]));
    expect(h.queryAll('.cloudlinks')).toHaveLength(0);
    expect(h.queryAll('.cloudrow')).toHaveLength(0);
  });

  it('offers Unlink in the row menu only for manual links', async () => {
    const h = await mount(stateWith([row(1, { cloudSessions: [chip(URL_A, 'manual')] }), row(2, { cloudSessions: [chip(URL_B, 'pr')] })]));
    await h.click('.row [data-menu="920001"]');
    const items = h.queryAll('#ctxMenu .ctxitem').map((e) => e.textContent?.trim());
    expect(items).toContain('Unlink cloud session');
    await h.click('#ctxMenu [data-act="cloud-session-unlink"]');
    expect(h.posted.at(-1)).toMatchObject({ type: 'cloud-session-unlink', url: URL_A });
    await h.click('.row [data-menu="920002"]');
    expect(h.queryAll('#ctxMenu [data-act="cloud-session-unlink"]')).toHaveLength(0);
  });
});

describe('unlinked cloud session rows', () => {
  it('shows a Cloud sessions section mixed into the list, even with no tickets', async () => {
    const h = await mount(stateWith([], [unlinked(1, URL_A), unlinked(2, URL_B, { proposalId: 5, proposalLabel: 'D5' })]));
    expect(h.queryAll('.k-empty')).toHaveLength(0);
    expect(h.queryAll('.sec .sec-name').map((e) => e.textContent)).toEqual(['Cloud sessions']);
    expect(h.queryAll('.cloudrow')).toHaveLength(2);
    expect(h.queryAll('.cloudrow .k-chip').map((e) => e.textContent)).toEqual(['D5']);
    await h.click('.cloudrow .rowopen');
    expect(h.posted.at(-1)).toMatchObject({ type: 'cloud-session-open', url: URL_A });
  });

  it('keeps the ticket count off the cloud rows', async () => {
    const h = await mount(stateWith([row(1)], [unlinked(1, URL_A)]));
    expect(h.query('[data-pane="tickets"] .pane-count')!.textContent).toBe('1');
  });

  it('links to a ticket or a pending draft from the Link to… menu', async () => {
    const withDraft = fixture('all-sections').planning.length
      ? fixture('all-sections').planning
      : [];
    const pending = withDraft.flatMap((p) => p.proposals).find((d) => d.status === 'pending');
    const h = await mount(stateWith([row(1)], [unlinked(1, URL_A)], { planning: withDraft }));
    const trigger = h.query<HTMLButtonElement>('.cloudrow [data-menu]')!;
    expect(trigger.getAttribute('aria-label')).toBe('Link to…');
    expect(trigger.getAttribute('aria-haspopup')).toBe('menu');
    await h.click(trigger);
    await h.click(`#ctxMenu [data-act="cloud-session-link"][data-id="${920001}"]`);
    expect(h.posted.at(-1)).toMatchObject({ type: 'cloud-session-link', url: URL_A, ticketId: 920001 });
    expect(pending).toBeDefined();
    await h.click(h.query('.cloudrow [data-menu]')!);
    await h.click(`#ctxMenu [data-act="cloud-session-link"][data-proposal="${pending!.id}"]`);
    expect(h.posted.at(-1)).toMatchObject({ type: 'cloud-session-link', url: URL_A, proposalId: pending!.id });
  });

  it('renders a hostile label as text', async () => {
    const h = await mount(stateWith([], [unlinked(1, URL_A, { label: '<img src=x onerror=alert(1)>' })]));
    expect(h.queryAll('.cloudrow img')).toHaveLength(0);
    expect(h.query('.cloudrow .name')!.textContent).toBe('<img src=x onerror=alert(1)>');
  });
});
