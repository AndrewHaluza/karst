// @vitest-environment jsdom
/**
 * Ticket form B′ (D287): the source header, the inline brief card and the
 * approach listbox, rendered through the production hydrate chain.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderWebview, type RenderHandle } from '../testing/renderHarness.js';

function baseState(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    mode: 'edit', provider: 'clickup', title: 'Add override', key: 'T42', description: '',
    repos: [], approaches: [], agents: [], unclassified: [], attachments: [],
    sourceRef: '86c2f9qke', ticketUrl: 'https://app.clickup.com/t/86c2f9qke',
    brief: '', briefFetchedAt: null,
    ...over,
  };
}

const APPROACHES = [
  { id: 'sp', label: 'Superpowers', description: 'Brainstorm → plan → TDD', recommended: true },
  { id: 'gsd', label: 'GSD', description: 'Phase-based plan / execute / verify' },
  { id: 'quick', label: 'Quick fix', description: 'Single implement stage' },
];

function lines(n: number): string {
  return Array.from({ length: n }, (_, i) => `line ${i + 1}`).join('\n');
}

function fetched(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    title: 'Add override', description: lines(10), tags: ['frontend', 'picker'],
    comments: [], attachments: [], url: 'https://app.clickup.com/t/86c2f9qke',
    ...over,
  };
}

let h: RenderHandle | null = null;
afterEach(() => { h?.close(); h = null; });

function open(state: Record<string, unknown>): RenderHandle {
  h = renderWebview('ticketForm');
  h.receive({ type: 'state', state });
  return h;
}
function postedOfType(v: RenderHandle, type: string): Record<string, unknown>[] {
  return v.posted.filter((m) => (m as { type: string }).type === type) as Record<string, unknown>[];
}
const text = (v: RenderHandle, sel: string): string => v.query(sel)?.textContent?.replace(/\s+/g, ' ').trim() ?? '';

describe('source header', () => {
  it('shows badge, label, mono id link, copy, open and Re-fetch for a bound ticket', () => {
    const v = open(baseState());
    const head = v.query('#srcHeader')!;
    expect(head.querySelector('svg')).not.toBeNull();
    expect(text(v, '#srcLabel')).toBe('ClickUp');
    const id = v.query<HTMLAnchorElement>('#srcId')!;
    expect(id.textContent).toBe('86c2f9qke');
    expect(id.dataset.url).toBe('https://app.clickup.com/t/86c2f9qke');
    const copy = v.query('#copyIdBtn')!;
    expect(copy.getAttribute('aria-label')).toBe('Copy ticket id');
    expect(copy.getAttribute('title')).toBe('Copy ticket id');
    expect(copy.classList.contains('k-iconbtn')).toBe(true);
    expect(v.query('#srcOpen')!.getAttribute('aria-label')).toBe('Open in ClickUp');
    expect(text(v, '#refetchBtn')).toBe('Re-fetch');
    expect(v.query('#keyRow')!.classList.contains('hidden')).toBe(true);
  });

  it('manual ticket: "Manual ticket" and no id controls', () => {
    const v = open(baseState({ provider: 'manual', sourceRef: null, ticketUrl: null }));
    expect(text(v, '#srcHeader')).toContain('Manual ticket');
    for (const sel of ['#srcId', '#copyIdBtn', '#srcOpen', '#refetchBtn']) expect(v.query(sel)).toBeNull();
  });

  it('create mode before a fetch shows the key input and Fetch', () => {
    const v = open(baseState({ mode: 'create', sourceRef: null, ticketUrl: null, key: '' }));
    expect(v.query('#keyRow')!.classList.contains('hidden')).toBe(false);
    expect(v.query('#fetchBtn')!.classList.contains('hidden')).toBe(false);
    expect(v.query('#copyIdBtn')).toBeNull();
  });

  it('puts the status filter next to Fetch only when search is enabled', () => {
    const on = open(baseState({ mode: 'create', sourceRef: null, ticketUrl: null, ticketSearchEnabled: true }));
    expect(on.query('#fetchBtn')!.parentElement!.contains(on.query('#searchFilterRow'))).toBe(true);
    expect(on.query('#searchFilterRow')!.classList.contains('hidden')).toBe(false);
    on.close();
    const off = open(baseState({ mode: 'create', sourceRef: null, ticketUrl: null }));
    expect(off.query('#searchFilterRow')!.classList.contains('hidden')).toBe(true);
  });

  it('Re-fetch posts fetch-source with the bound ref', () => {
    const v = open(baseState());
    v.click('#refetchBtn');
    expect(postedOfType(v, 'fetch-source')).toEqual([{ type: 'fetch-source', ref: '86c2f9qke' }]);
  });

  it('copy writes the id to the clipboard and flashes a check, then restores', async () => {
    vi.useFakeTimers();
    try {
      const v = open(baseState());
      const writeText = vi.fn().mockResolvedValue(undefined);
      Object.defineProperty(v.window.navigator, 'clipboard', { value: { writeText }, configurable: true });
      v.click('#copyIdBtn');
      await vi.advanceTimersByTimeAsync(0);
      expect(writeText).toHaveBeenCalledWith('86c2f9qke');
      expect(v.query('#copyIdBtn')!.classList.contains('is-copied')).toBe(true);
      expect(v.query('#copyIdBtn')!.getAttribute('aria-label')).toBe('Copy ticket id');
      await vi.advanceTimersByTimeAsync(2500);
      expect(v.query('#copyIdBtn')!.classList.contains('is-copied')).toBe(false);
    } finally { vi.useRealTimers(); }
  });

  it('a failed clipboard write says so instead of flashing success', async () => {
    const v = open(baseState());
    const writeText = vi.fn().mockRejectedValue(new Error('denied'));
    Object.defineProperty(v.window.navigator, 'clipboard', { value: { writeText }, configurable: true });
    v.click('#copyIdBtn');
    await new Promise((r) => setTimeout(r, 0));
    expect(v.query('#copyIdBtn')!.classList.contains('is-copied')).toBe(false);
    expect(v.query('#copyIdBtn')!.getAttribute('title')).toMatch(/copy failed/i);
  });
});

describe('brief card', () => {
  it('is absent without a brief', () => {
    const v = open(baseState());
    expect(v.query('#briefCard')).toBeNull();
    expect(v.query('#detailsBtn')).toBeNull();
    expect(v.query('#drawer')).toBeNull();
  });

  it('persisted brief, collapsed on open: heading stripped, no fetched-at when null', () => {
    const v = open(baseState({ brief: '# Add override\n\nbody line' }));
    expect(v.query('#briefCard')).not.toBeNull();
    expect(v.query('#briefToggle')!.getAttribute('aria-expanded')).toBe('false');
    expect(text(v, '#briefCard')).toContain('body line');
    expect(text(v, '#briefCard')).not.toContain('# Add override');
    expect(v.query('#briefFetched')).toBeNull();
    expect(v.query('#briefMeta')).toBeNull();
  });

  it('shows "fetched <relative>" from briefFetchedAt', () => {
    const at = new Date(Date.now() - 2 * 3600_000).toISOString();
    const v = open(baseState({ brief: '# T\n\nx', briefFetchedAt: at }));
    expect(text(v, '#briefFetched')).toBe('fetched 2 h ago');
    expect(text(v, '#briefCard')).toContain('ClickUp');
  });

  it('after a fetch: expanded, meta row, constant-driven excerpt not applied', () => {
    const v = open(baseState({ mode: 'create', sourceRef: null }));
    v.receive({ type: 'brief', brief: fetched({ status: 'In Progress', priority: 'High', milestone: 'cycle 42',
      people: [{ name: 'A', role: 'assignee' }, { name: 'B', role: 'watcher' }, { name: 'C', role: 'watcher' }, { name: 'D', role: 'watcher' }, { name: 'E', role: 'watcher' }] }) });
    expect(v.query('#briefToggle')!.getAttribute('aria-expanded')).toBe('true');
    const meta = text(v, '#briefMeta');
    for (const w of ['In Progress', 'High', 'cycle 42', 'frontend', 'picker', 'A', 'B', 'C', '+2']) expect(meta).toContain(w);
    expect(meta).not.toContain('D ');
    expect(text(v, '#briefCard')).toContain('line 10');
    expect(text(v, '#briefFetched')).toBe('fetched just now');
  });

  it('tags-only brief: meta row holds the tags and nothing else', () => {
    const v = open(baseState({ mode: 'create', sourceRef: null }));
    v.receive({ type: 'brief', brief: fetched() });
    expect(v.queryAll('#briefMeta .k-chip').map((e) => e.textContent)).toEqual(['frontend', 'picker']);
  });

  it('hides the meta row when there is nothing to show', () => {
    const v = open(baseState({ mode: 'create', sourceRef: null }));
    v.receive({ type: 'brief', brief: fetched({ tags: [] }) });
    expect(v.query('#briefMeta')).toBeNull();
  });

  it('collapsed: first 6 lines, "Show full brief (N more lines) · K comments"; expand and collapse', () => {
    const v = open(baseState({ mode: 'create', sourceRef: null }));
    v.receive({ type: 'brief', brief: fetched({ comments: [
      { author: 'Jana Lind', text: 'one', date: '2026-10-24T14:02:00Z' },
      { author: 'Marek Kral', text: 'two', date: '2026-10-25T09:41:00Z' },
    ] }) });
    v.click('#briefCollapse');
    expect(v.query('#briefToggle')!.getAttribute('aria-expanded')).toBe('false');
    expect(text(v, '#briefCard')).toContain('line 6');
    expect(text(v, '#briefCard')).not.toContain('line 7');
    expect(text(v, '#briefMore')).toBe('Show full brief (4 more lines) · 2 comments');
    v.click('#briefMore');
    expect(text(v, '#briefCard')).toContain('line 10');
    expect(v.query('#briefMore')).toBeNull();
  });

  it('excerpt and comment caps are the mirrored constants', () => {
    const src = readFileSync(join(__dirname, 'webview.html'), 'utf8');
    expect(src).toMatch(/const BRIEF_EXCERPT_LINES = 6;/);
    expect(src).toMatch(/const BRIEF_COMMENT_MAX_CHARS = 600;/);
  });

  it('expanded: attachments, comments oldest first with initials, escaped text', () => {
    const v = open(baseState({ mode: 'create', sourceRef: null }));
    v.receive({ type: 'brief', brief: fetched({
      attachments: [{ name: 'current-picker.png', url: 'https://x/y.png', size: 114688 }],
      comments: [
        { author: 'Marek Kral', text: '<img src=x onerror=alert(1)>', date: '2026-10-25T09:41:00Z' },
        { author: 'Jana Lind', text: 'older', date: '2026-10-24T14:02:00Z' },
      ] }) });
    expect(text(v, '#briefAttachments')).toContain('Attachments · 1');
    expect(text(v, '#briefAttachments')).toContain('current-picker.png');
    expect(text(v, '#briefComments')).toContain('Comments · 2');
    const authors = v.queryAll('.brief-comment .brief-author').map((e) => e.textContent);
    expect(authors).toEqual(['Jana Lind', 'Marek Kral']);
    expect(v.queryAll('.brief-comment .brief-avatar').map((e) => e.textContent)).toEqual(['JL', 'MK']);
    expect(v.query('#briefComments img')).toBeNull();
    expect(text(v, '#briefComments')).toContain('<img src=x onerror=alert(1)>');
    expect(text(v, '#briefCard')).toContain('Read-only. Reply in ClickUp.');
  });

  it('caps a long comment at 600 chars with an inline more toggle', () => {
    const v = open(baseState({ mode: 'create', sourceRef: null }));
    v.receive({ type: 'brief', brief: fetched({ comments: [
      { author: 'A B', text: 'x'.repeat(700), date: '2026-10-24T14:02:00Z' },
    ] }) });
    const body = (): string => v.query('.brief-comment .brief-text')!.textContent!;
    expect(body().replace(/…$/, '').length).toBeLessThanOrEqual(600);
    expect(body().length).toBeLessThan(700);
    v.click('[data-comment-more="0"]');
    expect(body().length).toBe(700);
    expect(v.query('[data-comment-more="0"]')!.textContent).toBe('less');
  });

  it('the body scrolls inside the card via the --k-brief-max-h token', () => {
    const v = open(baseState());
    const rule = v.cssRules().find((r) => r.selectorText === '.brief-body');
    expect(rule?.style.getPropertyValue('max-height')).toBe('var(--k-brief-max-h)');
    expect(rule?.style.getPropertyValue('overflow')).toBe('auto');
  });

  it('attach-to-ticket posts the attachment index with pending feedback', () => {
    const v = open(baseState({ mode: 'create', sourceRef: null }));
    v.receive({ type: 'brief', brief: fetched({ attachments: [
      { name: 'a.png', url: 'https://x/a.png' }, { name: 'b.png', url: 'https://x/b.png' },
    ] }) });
    v.click('[data-brief-attach="1"]');
    const [m] = postedOfType(v, 'attach-brief-attachment');
    expect(m).toMatchObject({ type: 'attach-brief-attachment', index: 1 });
    expect(typeof m!.requestId).toBe('string');
  });

  it('Open ↗ opens the ticket link', () => {
    const v = open(baseState({ mode: 'create', sourceRef: null }));
    v.receive({ type: 'brief', brief: fetched() });
    v.click('#briefOpen');
    expect(postedOfType(v, 'open-ticket-link')).toEqual([
      { type: 'open-ticket-link', url: 'https://app.clickup.com/t/86c2f9qke' }]);
  });

  it('Use as prompt replaces #desc with the description only; Undo restores; editing ends the undo', () => {
    const v = open(baseState({ mode: 'create', sourceRef: null }));
    const desc = v.query<HTMLTextAreaElement>('#desc')!;
    desc.value = 'my draft';
    v.receive({ type: 'brief', brief: fetched({ description: 'D body', comments: [
      { author: 'A B', text: 'secret comment', date: '2026-10-24T14:02:00Z' }] }) });
    expect(desc.value).toBe('my draft');
    v.click('#briefUse');
    expect(desc.value).toBe('D body');
    expect(desc.value).not.toContain('secret comment');
    expect(v.query('#briefUndo')).not.toBeNull();
    v.click('#briefUndo');
    expect(desc.value).toBe('my draft');
    expect(v.query('#briefUndo')).toBeNull();
    v.click('#briefUse');
    desc.value = 'D body edited';
    desc.dispatchEvent(new v.window.Event('input', { bubbles: true }));
    expect(v.query('#briefUndo')).toBeNull();
  });

  it('removes the drawer and the Show details link', () => {
    const v = open(baseState({ brief: '# T\n\nx' }));
    for (const sel of ['#detailsBtn', '#drawer', '#scrim', '#drawerClose']) expect(v.query(sel)).toBeNull();
  });
});

describe('approach picker', () => {
  const withApproaches = (over: Record<string, unknown> = {}): Record<string, unknown> =>
    baseState({ approaches: APPROACHES, selectedApproach: 'sp', ...over });

  it('closed: button-card with label, Recommended pill and description', () => {
    const v = open(withApproaches());
    const btn = v.query('#approachBtn')!;
    expect(btn.getAttribute('aria-haspopup')).toBe('listbox');
    expect(btn.getAttribute('aria-expanded')).toBe('false');
    expect(btn.textContent).toContain('Superpowers');
    expect(btn.textContent).toContain('Recommended');
    expect(btn.textContent).toContain('Brainstorm → plan → TDD');
    expect(v.query('#approachListbox')!.classList.contains('hidden')).toBe(true);
    expect(v.query('.acard')).toBeNull();
  });

  it('opens a listbox of options with aria-selected, ✓ and ★', () => {
    const v = open(withApproaches());
    v.click('#approachBtn');
    expect(v.query('#approachBtn')!.getAttribute('aria-expanded')).toBe('true');
    const lb = v.query('#approachListbox')!;
    expect(lb.getAttribute('role')).toBe('listbox');
    const opts = v.queryAll('#approachListbox [role="option"]');
    expect(opts.map((o) => o.getAttribute('aria-selected'))).toEqual(['true', 'false', 'false']);
    expect(opts[0]!.textContent).toContain('✓');
    expect(opts[0]!.textContent).toContain('★');
    expect(opts[1]!.textContent).toContain('Phase-based plan');
    expect(opts[1]!.textContent).not.toContain('✓');
  });

  it('click picks, posts set-approach with requestId, closes', () => {
    const v = open(withApproaches());
    v.click('#approachBtn');
    v.click('[data-approach="gsd"]');
    const [m] = postedOfType(v, 'set-approach');
    expect(m).toMatchObject({ type: 'set-approach', id: 'gsd' });
    expect(typeof m!.requestId).toBe('string');
    expect(v.query('#approachBtn')!.textContent).toContain('GSD');
    expect(v.query('#approachListbox')!.classList.contains('hidden')).toBe(true);
  });

  const key = (v: RenderHandle, sel: string, k: string): void => {
    v.query(sel)!.dispatchEvent(new v.window.KeyboardEvent('keydown', { key: k, bubbles: true }));
  };

  it('keyboard: arrows, Home/End move the active option, Enter picks, Esc closes and refocuses', () => {
    const v = open(withApproaches());
    v.click('#approachBtn');
    const active = (): string | null => v.query('#approachListbox')!.getAttribute('aria-activedescendant');
    const optId = (i: number): string => v.queryAll('#approachListbox [role="option"]')[i]!.id;
    expect(active()).toBe(optId(0));
    key(v, '#approachListbox', 'ArrowDown');
    expect(active()).toBe(optId(1));
    key(v, '#approachListbox', 'End');
    expect(active()).toBe('approachManage');
    key(v, '#approachListbox', 'Home');
    expect(active()).toBe(optId(0));
    key(v, '#approachListbox', 'ArrowUp');
    expect(active()).toBe('approachManage');
    key(v, '#approachListbox', 'ArrowDown');
    key(v, '#approachListbox', 'ArrowDown');
    key(v, '#approachListbox', 'Enter');
    expect(postedOfType(v, 'set-approach')[0]).toMatchObject({ id: 'gsd' });
    v.click('#approachBtn');
    key(v, '#approachListbox', 'Escape');
    expect(v.query('#approachBtn')!.getAttribute('aria-expanded')).toBe('false');
    expect(v.document.activeElement).toBe(v.query('#approachBtn'));
  });

  it('"Manage approaches…" posts open-settings', () => {
    const v = open(withApproaches());
    v.click('#approachBtn');
    v.click('#approachManage');
    expect(postedOfType(v, 'open-settings')).toEqual([{ type: 'open-settings' }]);
  });

  it('keeps the empty state', () => {
    const v = open(baseState({ approaches: [] }));
    expect(text(v, '#approachList')).toContain('No approaches installed');
    expect(v.query('#approachBtn')).toBeNull();
  });

  it('an AI suggestion badges its option but never moves the pick', () => {
    const v = open(withApproaches());
    v.receive({ type: 'analysis', prompt: 'p', approachId: 'quick', reason: 'small change', repos: [], ticketType: '', intent: null, codePointers: null, warnings: [] });
    v.click('#approachBtn');
    expect(text(v, '[data-approach="quick"]')).toContain('small change');
    expect(v.query('#approachBtn')!.textContent).toContain('Superpowers');
  });
});
