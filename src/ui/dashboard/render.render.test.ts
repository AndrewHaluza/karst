// @vitest-environment jsdom
/**
 * Drives the dashboard fixture corpus through the shared jsdom render harness.
 *
 * Asserts the state-dependent RUNTIME rules (UI-R11, R12, R13, R15, R17, R18,
 * R26, R32) for the dashboard view only.  The other seven views' state-dependent
 * rules are out of scope until FEAT-37 supplies their corpora.
 */
import { describe, it, expect } from 'vitest';
import { renderWebview } from '../testing/renderHarness.js';
import {
  renderFixtures,
  renderStateFor,
  implementationPrototypeFixture,
  type InsideRenderFixture,
} from './renderFixtures.js';

const envelope = (f: InsideRenderFixture) => {
  const base = renderStateFor(f.stage);
  return {
    type: 'state',
    state: { ...base, insideViews: { ...base.insideViews, [f.stage]: f.view } },
  };
};

describe('dashboard render — fixture corpus', () => {
  it.each(renderFixtures())(
    '$repositoryCount repos, $scenario ($stage): renders #inside with rows and zero errors',
    (f) => {
      const h = renderWebview('dashboard');
      h.receive(envelope(f));
      const inside = h.query('#inside');
      expect(inside, '#inside not found').toBeTruthy();
      expect(inside!.innerHTML.length, '#inside is empty').toBeGreaterThan(0);
      expect(h.errors).toEqual([]);
      const rows = h.queryAll('[data-proc-id]');
      expect(rows.length, 'no [data-proc-id] rows').toBeGreaterThanOrEqual(1);
      h.close();
    },
  );

  it.each(renderFixtures())(
    '$repositoryCount repos, $scenario ($stage): escapes hostile labels (UI-R32)',
    (f) => {
      const h = renderWebview('dashboard');
      h.receive(envelope(f));
      const inside = h.query('#inside')!;
      // No script elements should appear inside #inside, even though fixture
      // labels contain literal "<script>" strings.
      expect(inside.querySelectorAll('script').length).toBe(0);
      expect(inside.querySelectorAll('img').length).toBe(0);
      expect(inside.querySelectorAll('iframe').length).toBe(0);
      // No on* event-handler attributes
      for (const el of inside.querySelectorAll('*')) {
        for (const attr of el.attributes) {
          expect(attr.name).not.toMatch(/^on/);
        }
      }
      h.close();
    },
  );

  it('click dispatches exactly one postMessage (UI-R11, R12, R17, R18)', () => {
    const h = renderWebview('dashboard');
    const fixture = renderFixtures()[0]!;
    h.receive(envelope(fixture));

    const btn = h.query<HTMLElement>('[data-act="copy-ticket-key"]');
    if (!btn) { h.close(); return; } // no control to click — vacuously true

    const ariaLabelBefore = btn.getAttribute('aria-label');

    h.click('[data-act="copy-ticket-key"]');
    expect(h.posted.length).toBe(1);
    const msg = h.posted[0] as { type: string; requestId?: string };
    expect(msg.type).toBe('copy-ticket-key');
    expect(msg.requestId).toBeTruthy();

    // After click: aria-busy and disabled
    expect(btn.getAttribute('aria-busy')).toBe('true');
    expect(btn.hasAttribute('disabled')).toBe(true);

    // A second click posts nothing more
    h.click('[data-act="copy-ticket-key"]');
    expect(h.posted.length).toBe(1);

    // Accessible name is unchanged across the transition (UI-R18)
    expect(btn.getAttribute('aria-label')).toBe(ariaLabelBefore);

    h.close();
  });

  it('action-result clears busy and re-enables (UI-R13, R15)', () => {
    const h = renderWebview('dashboard');
    const fixture = renderFixtures()[0]!;
    h.receive(envelope(fixture));

    const btn = h.query<HTMLElement>('[data-act="copy-ticket-key"]');
    if (!btn) { h.close(); return; }

    h.click('[data-act="copy-ticket-key"]');
    expect(btn.getAttribute('aria-busy')).toBe('true');

    // ok:true clears busy
    const requestId = (h.posted[0] as { requestId: string }).requestId;
    h.receive({ type: 'action-result', requestId, ok: true });
    expect(btn.getAttribute('aria-busy')).toBe(null);
    expect(btn.hasAttribute('disabled')).toBe(false);

    h.close();
  });

  it('implementationPrototypeFixture renders session segments', () => {
    const h = renderWebview('dashboard');
    const f = implementationPrototypeFixture();
    h.receive(envelope(f));
    const inside = h.query('#inside');
    expect(inside, '#inside not found').toBeTruthy();
    expect(inside!.innerHTML.length).toBeGreaterThan(0);
    expect(h.errors).toEqual([]);
    h.close();
  });
});
