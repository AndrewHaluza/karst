// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { renderWebview, type RenderHandle } from '../testing/renderHarness.js';
import { sidebarRenderFixtures, fixturePlanningRow, HOSTILE_LABEL as HOSTILE } from './renderFixtures.js';
import type { SidebarState, PlanningRow } from './state.js';

const NONCE = 'fixture-nonce-000000000000';
const stateOf = (scenario: string) => sidebarRenderFixtures().find((f) => f.scenario === scenario)!.state;
const withPlans = (planning: PlanningRow[]): SidebarState => ({ ...stateOf('empty'), planning });

function key(h: RenderHandle, target: Element, k: string, init: KeyboardEventInit = {}): void {
  target.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init }));
}
const session = (h: RenderHandle, id: number) => h.query<HTMLElement>(`[role="treeitem"][data-node="s${id}"]`)!;
const draft = (h: RenderHandle, id: number) => h.query<HTMLElement>(`[role="treeitem"][data-node="d${id}"]`)!;

describe('sidebar planning tree', () => {
  it('renders a Planning tree above the ticket sections', () => {
    const h = renderWebview('sidebar', { nonce: NONCE });
    try {
      h.receive({ type: 'state', state: stateOf('all-sections') });
      const names = h.queryAll('.sec-name').map((n) => n.textContent);
      expect(names[0]).toBe('Planning');
      expect(names).toContain('Current');
      const tree = h.query('[role="tree"]')!;
      expect(tree.getAttribute('aria-label')).toBe('Planning sessions');
      expect(h.queryAll('[role="treeitem"][aria-level="1"]')).toHaveLength(2);
    } finally { h.close(); }
  });

  it('a session row has a twistie, a status dot, the title and a muted draft count — no text pills', () => {
    const h = renderWebview('sidebar', { nonce: NONCE });
    try {
      h.receive({ type: 'state', state: stateOf('all-sections') });
      const row = session(h, 90).querySelector('.pt-row')!;
      expect(row.querySelector('.pt-twistie')).not.toBeNull();
      expect(row.querySelector('.pt-dot')).not.toBeNull();
      expect(row.querySelector('.pt-label')!.textContent).toBe('Planning 90');
      expect(row.querySelector('.pt-count')!.textContent).toBe('2');
      expect(row.querySelector('.k-pill,.agent-identity,.plan-meta')).toBeNull();
      expect(row.textContent).not.toMatch(/terminal open|filed|needs review/);
    } finally { h.close(); }
  });

  it('puts agent, model and the status word in the tooltip and aria-label (UI-R10c, colour never alone)', () => {
    const h = renderWebview('sidebar', { nonce: NONCE });
    try {
      h.receive({ type: 'state', state: stateOf('all-sections') });
      const s = session(h, 90);
      expect(s.getAttribute('aria-label')).toBe('Planning 90, needs review, Claude Code · opus, 2 drafts');
      expect(s.querySelector('.pt-row')!.getAttribute('title')).toBe(s.getAttribute('aria-label'));
      expect(session(h, 89).getAttribute('aria-label')).toBe('Planning 89, terminal not live, Claude Code · opus, 0 drafts');
    } finally { h.close(); }
  });

  it('colours sessions by precedence: yellow > blue > green > grey', () => {
    const h = renderWebview('sidebar', { nonce: NONCE });
    try {
      h.receive({ type: 'state', state: withPlans([
        fixturePlanningRow(1, { live: true, status: 'filed', proposals: [{ id: 11, title: 'p', status: 'pending', ticketId: null }] }),
        fixturePlanningRow(2, { live: true, status: 'filed' }),
        fixturePlanningRow(3, { status: 'filed' }),
        fixturePlanningRow(4, { proposals: [{ id: 41, title: 'a', status: 'accepted', ticketId: 9 }] }),
        fixturePlanningRow(5),
      ]) });
      const dot = (id: number) => session(h, id).querySelector('.pt-dot')!.className;
      expect(dot(1)).toContain('pt-dot--attention');
      expect(dot(2)).toContain('pt-dot--running');
      expect(dot(3)).toContain('pt-dot--passed');
      expect(dot(4)).toContain('pt-dot--passed');
      expect(dot(5)).toContain('pt-dot--pending');
      expect(session(h, 2).getAttribute('aria-label')).toMatch(/terminal live/);
      expect(session(h, 3).getAttribute('aria-label')).toMatch(/filed/);
    } finally { h.close(); }
  });

  it('expands a session with pending drafts by default and collapses one without', () => {
    const h = renderWebview('sidebar', { nonce: NONCE });
    try {
      h.receive({ type: 'state', state: withPlans([
        fixturePlanningRow(1, { proposals: [{ id: 11, title: 'p', status: 'pending', ticketId: null }] }),
        fixturePlanningRow(2, { proposals: [{ id: 21, title: 'a', status: 'accepted', ticketId: 9 }] }),
        fixturePlanningRow(3),
      ]) });
      expect(session(h, 1).getAttribute('aria-expanded')).toBe('true');
      expect(session(h, 2).getAttribute('aria-expanded')).toBe('false');
      expect(draft(h, 21)).toBeNull();
      expect(session(h, 3).hasAttribute('aria-expanded')).toBe(false);
    } finally { h.close(); }
  });

  it('the twistie toggles a session and the choice survives a re-render', () => {
    const h = renderWebview('sidebar', { nonce: NONCE });
    try {
      h.receive({ type: 'state', state: stateOf('all-sections') });
      const before = h.posted.length;
      h.click('[data-node="s90"] .pt-twistie');
      expect(h.posted.slice(before)).toEqual([]);
      expect(session(h, 90).querySelector('.pt-twistie')!.hasAttribute('data-open')).toBe(false);
      expect(session(h, 90).getAttribute('aria-expanded')).toBe('false');
      expect(draft(h, 501)).toBeNull();
      h.receive({ type: 'state', state: stateOf('all-sections') });
      expect(session(h, 90).getAttribute('aria-expanded')).toBe('false');
      expect(h.posted.some((m) => /^plan-/.test((m as { type: string }).type))).toBe(false);
    } finally { h.close(); }
  });

  it('posts plan-open and plan-archive with a sessionId, never a ticketId, and goes pending', () => {
    const h = renderWebview('sidebar', { nonce: NONCE });
    try {
      h.receive({ type: 'state', state: stateOf('all-sections') });
      h.click('[data-act="plan-open"][data-plan="90"]');
      h.click('[data-act="plan-archive"][data-plan="89"]');
      const sent = h.posted.filter((m) => /^plan-/.test((m as { type: string }).type));
      expect(sent).toEqual([
        expect.objectContaining({ type: 'plan-open', sessionId: 90 }),
        expect.objectContaining({ type: 'plan-archive', sessionId: 89 }),
      ]);
      expect(sent.every((m) => !('ticketId' in (m as object)))).toBe(true);
      expect(h.query('[data-act="plan-open"][data-plan="90"]')!.getAttribute('aria-busy')).toBe('true');
    } finally { h.close(); }
  });

  it('section header carries the count, a start-session + and Collapse all', () => {
    const h = renderWebview('sidebar', { nonce: NONCE });
    try {
      h.receive({ type: 'state', state: stateOf('all-sections') });
      const sec = h.query('.sec.pt-sec')!;
      expect(sec.querySelector('.sec-n')!.textContent).toContain('2');
      expect(sec.querySelector('[data-act="plan-create"]')!.getAttribute('aria-label')).toBe('Start planning session');
      h.click('.pt-sec [data-plan-collapse-all]');
      expect(session(h, 90).getAttribute('aria-expanded')).toBe('false');
      h.click('.pt-sec [data-act="plan-create"]');
      expect(h.posted).toContainEqual(expect.objectContaining({ type: 'plan-create' }));
    } finally { h.close(); }
  });

  it('has a named toolbar control to start a planning session', () => {
    const h = renderWebview('sidebar', { nonce: NONCE });
    try {
      h.receive({ type: 'state', state: stateOf('empty') });
      const btn = h.query('[data-act="plan-create"]')!;
      expect(btn.getAttribute('aria-label')).toBe('Start planning session');
      h.click('[data-act="plan-create"]');
      expect(h.posted).toContainEqual(expect.objectContaining({ type: 'plan-create' }));
    } finally { h.close(); }
  });

  it('escapes a hostile session title and model id (UI-R32)', () => {
    const h = renderWebview('sidebar', { nonce: NONCE });
    try {
      h.receive({ type: 'state', state: stateOf('hostile') });
      expect(h.query('[role="tree"] script,[role="tree"] img')).toBeNull();
      const s = session(h, 91);
      expect(s.querySelector('.pt-label')!.textContent).toBe(HOSTILE);
      expect(s.getAttribute('aria-label')).toContain(HOSTILE);
      expect(s.getAttribute('aria-label')).toContain('<img src=x onerror=alert(1)>');
      expect(h.query('[data-act="plan-open"][data-plan="91"]')!.getAttribute('aria-label')).toBe(`Open terminal: ${HOSTILE}`);
      expect(h.query('[data-act="plan-archive"][data-plan="91"]')!.getAttribute('aria-label')).toBe(`Archive ${HOSTILE}`);
    } finally { h.close(); }
  });

  it('lists archived sessions under the Archived facet in the same tree, with Unarchive', () => {
    const h = renderWebview('sidebar', { nonce: NONCE });
    try {
      h.receive({ type: 'state', state: stateOf('archived-facet') });
      expect(h.query('[role="tree"] [data-node="s77"]')).not.toBeNull();
      expect(h.query('[data-act="plan-archive"]')).toBeNull();
      const btn = h.query('[data-act="plan-unarchive"][data-plan="77"]')!;
      expect(btn.getAttribute('aria-label')).toBe('Unarchive Old plan');
      h.click('[data-act="plan-unarchive"][data-plan="77"]');
      expect(h.posted).toContainEqual(expect.objectContaining({ type: 'plan-unarchive', sessionId: 77 }));
    } finally { h.close(); }
  });

  it('announces archive and unarchive through the action-result live region', () => {
    const h = renderWebview('sidebar', { nonce: NONCE });
    try {
      h.receive({ type: 'state', state: stateOf('archived-facet') });
      h.click('[data-act="plan-unarchive"][data-plan="77"]');
      const sent = h.posted.find((m) => (m as { type: string }).type === 'plan-unarchive') as { requestId: string };
      h.receive({ type: 'action-result', requestId: sent.requestId, ok: true });
      expect(h.query('[aria-live="polite"]')!.textContent).toMatch(/Planning session restored/);
    } finally { h.close(); }
  });

  it('plan-create settles on the host ack and announces only when the new row arrives (cancel stays quiet)', () => {
    const h = renderWebview('sidebar', { nonce: NONCE });
    try {
      h.receive({ type: 'state', state: stateOf('empty') });
      h.click('[data-act="plan-create"]');
      const sent = h.posted.find((m) => (m as { type: string }).type === 'plan-create') as { requestId: string };
      h.receive({ type: 'action-result', requestId: sent.requestId, ok: true });
      expect(h.query('[data-act="plan-create"]')!.getAttribute('aria-busy')).toBeNull();
      h.receive({ type: 'state', state: stateOf('empty') });
      expect(h.query('[aria-live="polite"]')?.textContent ?? '').not.toMatch(/Planning session started/);
      h.click('[data-act="plan-create"]');
      const again = h.posted.filter((m) => (m as { type: string }).type === 'plan-create').pop() as { requestId: string };
      h.receive({ type: 'action-result', requestId: again.requestId, ok: true });
      h.receive({ type: 'state', state: stateOf('all-sections') });
      expect(h.query('[aria-live="polite"]')!.textContent).toMatch(/Planning session started: Planning 90/);
    } finally { h.close(); }
  });
});

describe('sidebar planning drafts', () => {
  it('a pending draft has a status icon, the title, and named Review / Approve / Discard icon actions', () => {
    const h = renderWebview('sidebar', { nonce: NONCE });
    try {
      h.receive({ type: 'state', state: stateOf('all-sections') });
      const d = draft(h, 501);
      expect(d.getAttribute('aria-level')).toBe('2');
      expect(d.getAttribute('aria-label')).toBe('Add rate limit, needs review');
      expect(d.querySelector('.pt-icon.pt-c-attention')).not.toBeNull();
      const btn = (act: string) => d.querySelector(`[data-act="${act}"][data-proposal="501"]`)!;
      expect(btn('plan-proposal-view').getAttribute('aria-label')).toBe('Review draft: Add rate limit');
      expect(btn('plan-proposal-review').getAttribute('aria-label')).toBe('Approve draft: Add rate limit');
      expect(btn('plan-proposal-discard').getAttribute('aria-label')).toBe('Discard draft: Add rate limit');
      expect(d.querySelector('.k-btn')).toBeNull();
    } finally { h.close(); }
  });

  it('posts a proposalId (never a ticketId or sessionId) for each draft action and goes pending', () => {
    const h = renderWebview('sidebar', { nonce: NONCE });
    try {
      h.receive({ type: 'state', state: stateOf('all-sections') });
      h.click('[data-act="plan-proposal-view"][data-proposal="501"]');
      h.click('[data-act="plan-proposal-review"][data-proposal="501"]');
      h.click('[data-act="plan-proposal-discard"][data-proposal="501"]');
      const sent = h.posted.filter((m) => /^plan-proposal-/.test((m as { type: string }).type));
      expect(sent).toEqual([
        expect.objectContaining({ type: 'plan-proposal-view', proposalId: 501 }),
        expect.objectContaining({ type: 'plan-proposal-review', proposalId: 501 }),
        expect.objectContaining({ type: 'plan-proposal-discard', proposalId: 501 }),
      ]);
      expect(sent.every((m) => !('ticketId' in (m as object)) && !('sessionId' in (m as object)))).toBe(true);
      expect(h.query('[data-act="plan-proposal-review"][data-proposal="501"]')!.getAttribute('aria-busy')).toBe('true');
    } finally { h.close(); }
  });

  it('an accepted draft stays as a muted, struck-through row linking to its ticket, with no actions', () => {
    const h = renderWebview('sidebar', { nonce: NONCE });
    try {
      h.receive({ type: 'state', state: stateOf('all-sections') });
      const d = draft(h, 503);
      expect(d.classList.contains('pt-accepted')).toBe(true);
      expect(d.getAttribute('aria-label')).toBe('Split auth module, accepted as ticket #3');
      expect(d.querySelector('.pt-icon.pt-c-passed')).not.toBeNull();
      expect(d.querySelector('[data-act^="plan-proposal-"]')).toBeNull();
      const link = d.querySelector('[data-open="3"]')!;
      expect(link.textContent).toBe('#3');
      h.click('[data-node="d503"] [data-open="3"]');
      expect(h.posted).toContainEqual(expect.objectContaining({ type: 'open-ticket', ticketId: 3 }));
    } finally { h.close(); }
  });

  it('escapes a hostile draft title in text and labels (UI-R32)', () => {
    const h = renderWebview('sidebar', { nonce: NONCE });
    try {
      h.receive({ type: 'state', state: stateOf('hostile') });
      expect(h.query('[data-node="d502"] script')).toBeNull();
      expect(h.query('[data-act="plan-proposal-view"][data-proposal="502"]')!.getAttribute('aria-label')).toBe(`Review draft: ${HOSTILE}`);
      expect(draft(h, 502).querySelector('.pt-label')!.textContent).toBe(HOSTILE);
    } finally { h.close(); }
  });
});

describe('sidebar planning tree keyboard', () => {
  it('uses a roving tabindex: only the first item is tabbable', () => {
    const h = renderWebview('sidebar', { nonce: NONCE });
    try {
      h.receive({ type: 'state', state: stateOf('all-sections') });
      const items = h.queryAll('[role="treeitem"]');
      expect(items.filter((i) => i.getAttribute('tabindex') === '0')).toHaveLength(1);
      expect(items[0]!.getAttribute('tabindex')).toBe('0');
      expect(h.queryAll('.pt-actions button').every((b) => b.getAttribute('tabindex') === '-1')).toBe(true);
    } finally { h.close(); }
  });

  it('ArrowDown/ArrowUp move through visible items; Left/Right collapse, expand and move', () => {
    const h = renderWebview('sidebar', { nonce: NONCE });
    try {
      h.receive({ type: 'state', state: stateOf('all-sections') });
      const s90 = session(h, 90);
      s90.focus();
      key(h, s90, 'ArrowDown');
      expect(h.document.activeElement).toBe(draft(h, 501));
      key(h, draft(h, 501), 'ArrowLeft');
      expect(h.document.activeElement).toBe(session(h, 90));
      key(h, session(h, 90), 'ArrowLeft');
      expect(session(h, 90).getAttribute('aria-expanded')).toBe('false');
      expect(h.document.activeElement).toBe(session(h, 90));
      key(h, session(h, 90), 'ArrowDown');
      expect(h.document.activeElement).toBe(session(h, 89));
      key(h, session(h, 89), 'ArrowUp');
      key(h, session(h, 90), 'ArrowRight');
      expect(session(h, 90).getAttribute('aria-expanded')).toBe('true');
      key(h, session(h, 90), 'ArrowRight');
      expect(h.document.activeElement).toBe(draft(h, 501));
    } finally { h.close(); }
  });

  it('Enter opens the terminal on a session and Review on a draft', () => {
    const h = renderWebview('sidebar', { nonce: NONCE });
    try {
      h.receive({ type: 'state', state: stateOf('all-sections') });
      key(h, session(h, 89), 'Enter');
      key(h, draft(h, 501), 'Enter');
      const sent = h.posted.filter((m) => /^plan-/.test((m as { type: string }).type));
      expect(sent).toEqual([
        expect.objectContaining({ type: 'plan-open', sessionId: 89 }),
        expect.objectContaining({ type: 'plan-proposal-view', proposalId: 501 }),
      ]);
    } finally { h.close(); }
  });

  it('Shift+F10 opens a context menu listing every action of the item', () => {
    const h = renderWebview('sidebar', { nonce: NONCE });
    try {
      h.receive({ type: 'state', state: stateOf('all-sections') });
      key(h, draft(h, 501), 'F10', { shiftKey: true });
      const items = h.queryAll('#ctxMenu.open [role="menuitem"]');
      expect(items.map((i) => i.getAttribute('data-act'))).toEqual(['plan-proposal-view', 'plan-proposal-review', 'plan-proposal-discard']);
      expect(h.document.activeElement).toBe(items[0]);
      h.click('#ctxMenu [data-act="plan-proposal-review"]');
      expect(h.posted).toContainEqual(expect.objectContaining({ type: 'plan-proposal-review', proposalId: 501 }));
      expect(h.query('#ctxMenu.open')).toBeNull();
    } finally { h.close(); }
  });

  it('the contextmenu event on a session lists Open terminal and Archive', () => {
    const h = renderWebview('sidebar', { nonce: NONCE });
    try {
      h.receive({ type: 'state', state: stateOf('all-sections') });
      session(h, 89).querySelector('.pt-row')!.dispatchEvent(new h.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
      const items = h.queryAll('#ctxMenu.open [role="menuitem"]');
      expect(items.map((i) => i.textContent!.trim())).toEqual(['Open terminal', 'Archive']);
    } finally { h.close(); }
  });
});
