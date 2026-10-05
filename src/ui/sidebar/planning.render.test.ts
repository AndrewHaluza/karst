// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { renderWebview } from '../testing/renderHarness.js';
import { sidebarRenderFixtures, HOSTILE_LABEL as HOSTILE } from './renderFixtures.js';

const NONCE = 'fixture-nonce-000000000000';
const stateOf = (scenario: string) => sidebarRenderFixtures().find((f) => f.scenario === scenario)!.state;

describe('sidebar planning group', () => {
  it('renders a separate Planning group above the ticket sections', () => {
    const h = renderWebview('sidebar', { nonce: NONCE });
    try {
      h.receive({ type: 'state', state: stateOf('all-sections') });
      const names = h.queryAll('.sec-name').map((n) => n.textContent);
      expect(names[0]).toBe('Planning');
      expect(names).toContain('Current');
      expect(h.queryAll('[data-act="plan-open"]')).toHaveLength(2);
    } finally { h.close(); }
  });

  it('shows the core as canonical icon + name and the drafts count (UI-R10c)', () => {
    const h = renderWebview('sidebar', { nonce: NONCE });
    try {
      h.receive({ type: 'state', state: stateOf('all-sections') });
      const row = h.query('[data-act="plan-open"][data-plan="90"]')!;
      expect(row.tagName).toBe('BUTTON');
      expect(row.querySelector('.agent-identity')).not.toBeNull();
      expect(row.textContent).toMatch(/2 drafts/);
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

  it('escapes a hostile session title (UI-R32)', () => {
    const h = renderWebview('sidebar', { nonce: NONCE });
    try {
      h.receive({ type: 'state', state: stateOf('hostile') });
      expect(h.query('[data-plan="91"] script')).toBeNull();
      expect(h.query('[data-act="plan-open"][data-plan="91"]')!.textContent).toContain('<script>');
    } finally { h.close(); }
  });

  it('names the open control and the archive button after the session (escaped)', () => {
    const h = renderWebview('sidebar', { nonce: NONCE });
    try {
      h.receive({ type: 'state', state: stateOf('hostile') });
      const open = h.query('[data-act="plan-open"][data-plan="91"]')!;
      expect(open.getAttribute('aria-label')).toBe(`Open planning session: ${HOSTILE}`);
      const arch = h.query('[data-act="plan-archive"][data-plan="91"]')!;
      expect(arch.getAttribute('aria-label')).toBe(`Archive ${HOSTILE}`);
      expect(arch.getAttribute('title')).toBe(`Archive ${HOSTILE}`);
    } finally { h.close(); }
  });

  it('says "terminal open" for a live session and shows a non-active status as a word', () => {
    const h = renderWebview('sidebar', { nonce: NONCE });
    try {
      h.receive({ type: 'state', state: stateOf('all-sections') });
      const live = h.query('[data-act="plan-open"][data-plan="90"]')!.textContent!;
      expect(live).toMatch(/terminal open/);
      expect(live).toMatch(/filed/);
      const idle = h.query('[data-act="plan-open"][data-plan="89"]')!.textContent!;
      expect(idle).not.toMatch(/terminal open|filed|active/);
    } finally { h.close(); }
  });

  it('escapes a hostile model id in the agent identity', () => {
    const h = renderWebview('sidebar', { nonce: NONCE });
    try {
      h.receive({ type: 'state', state: stateOf('hostile') });
      const row = h.query('[data-act="plan-open"][data-plan="91"]')!;
      expect(row.querySelector('img,script')).toBeNull();
      expect(row.querySelector('.agent-identity-model')!.textContent).toBe('<img src=x onerror=alert(1)>');
    } finally { h.close(); }
  });

  it('lists archived sessions under the Archived facet with an Unarchive action', () => {
    const h = renderWebview('sidebar', { nonce: NONCE });
    try {
      h.receive({ type: 'state', state: stateOf('archived-facet') });
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
      // Cancelled input box: the next state carries no new session — nothing announced.
      h.receive({ type: 'state', state: stateOf('empty') });
      expect(h.query('[aria-live="polite"]')?.textContent ?? '').not.toMatch(/Planning session started/);
      // A later create whose row arrives is announced.
      h.click('[data-act="plan-create"]');
      const again = h.posted.filter((m) => (m as { type: string }).type === 'plan-create').pop() as { requestId: string };
      h.receive({ type: 'action-result', requestId: again.requestId, ok: true });
      h.receive({ type: 'state', state: stateOf('all-sections') });
      expect(h.query('[aria-live="polite"]')!.textContent).toMatch(/Planning session started: Planning 90/);
    } finally { h.close(); }
  });
});

