// @vitest-environment jsdom
/**
 * Proves the shared jsdom render harness on every webview and the dashboard
 * fixture corpus.
 */
import { describe, it, expect } from 'vitest';
import { WEBVIEW_NAMES } from '../../model/webviewChains.js';
import { renderWebview, renderWebviewReady, waitForSettingsReady } from './renderHarness.js';

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

/**
 * `resetRealm` + the captured `pageScript` are what let a test file boot the
 * settings document ONCE and mount a fresh app per test. The old tree is left
 * detached, so the bridge it acquired must be neutralized before the next run —
 * this pins both halves: the live page still refuses a second acquire, the
 * reset clears the logs/flags, and replaying the script mounts again.
 */
describe('resetRealm — same-realm reboot', () => {
  it('clears the logs and remounts the settings app from the captured script', async () => {
    const h = await renderWebviewReady('settings');
    try {
      expect(h.document.documentElement.hasAttribute('data-karst-ready')).toBe(true);
      expect(h.pageScript).toBeTruthy();
      expect(h.document.querySelector('#root [data-karst-settings-app]')).not.toBeNull();
      // The first mount already posted (requestState), and the live page still
      // rejects a second acquisition.
      expect(h.posted.length).toBeGreaterThan(0);
      expect(() => (h.window as unknown as { acquireVsCodeApi(): unknown }).acquireVsCodeApi()).toThrow(
        /already called/,
      );

      h.resetRealm();
      expect(h.posted).toEqual([]);
      expect(h.errors).toEqual([]);
      expect(h.state).toBeUndefined();
      expect(h.document.documentElement.hasAttribute('data-karst-ready')).toBe(false);
      // The old (detached) bridge is inert: a late post must not reach the log.
      (h.window as unknown as { vscode: { postMessage(m: unknown): void } }).vscode.postMessage({
        type: 'stale-from-old-tree',
      });
      expect(h.posted).toEqual([]);

      (h.window as unknown as { eval(code: string): unknown }).eval(h.pageScript!);
      await waitForSettingsReady(h);
      expect(h.document.documentElement.hasAttribute('data-karst-ready')).toBe(true);
      expect(h.document.querySelector('#root [data-karst-settings-app]')).not.toBeNull();
    } finally {
      h.close();
    }
  });
});
