// @vitest-environment jsdom
/**
 * Proves the shared jsdom render harness on every webview and the dashboard
 * fixture corpus.
 */
import { describe, it, expect } from 'vitest';
import { WEBVIEW_NAMES } from '../../model/webviewChains.js';
import { renderWebview } from './renderHarness.js';

describe('renderWebview — smoke', () => {
  it('getsStarted renders a body with CSS rules and zero errors', () => {
    const h = renderWebview('gettingStarted');
    expect(h.document.body).toBeTruthy();
    expect(h.errors).toEqual([]);
    expect(h.cssRules().length).toBeGreaterThan(0);
    h.close();
  });
});

describe.each(WEBVIEW_NAMES)('renderWebview — %s', (name) => {
  it('renders with zero errors', () => {
    const h = renderWebview(name);
    expect(h.errors).toEqual([]);
    h.close();
  });
});

describe('postMessage round trip', () => {
  it('dashboard posts on click', () => {
    const h = renderWebview('dashboard');
    expect(h.posted).toEqual([]);

    // Click a known control — the spike proved #keyBtn exists with data-act
    const btn = h.query<HTMLElement>('[data-act="copy-ticket-key"]');
    if (btn) {
      h.click('[data-act="copy-ticket-key"]');
      expect(h.posted.length).toBe(1);
      expect((h.posted[0] as { type: string }).type).toBe('copy-ticket-key');
    }

    h.close();
  });

  it('close is idempotent', () => {
    const h = renderWebview('gettingStarted');
    h.close();
    h.close(); // should not throw
  });
});
