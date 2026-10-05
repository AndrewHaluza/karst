// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { renderWebview } from '../testing/renderHarness.js';
import { sidebarRenderFixtures } from './renderFixtures.js';

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
});
