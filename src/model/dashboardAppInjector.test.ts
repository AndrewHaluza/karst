import { describe, expect, it } from 'vitest';
import {
  DASHBOARD_APP_MARKER,
  DASHBOARD_APP_CSS_MARKER,
  injectDashboardApp,
  dashboardAppCss,
  dashboardAppJs,
} from './dashboardAppInjector.js';

describe('injectDashboardApp', () => {
  it('returns a document without the marker unchanged (vanilla view stays live)', () => {
    const html = '<html><body><div id="root"></div></body></html>';
    expect(injectDashboardApp(html)).toBe(html);
  });

  it('replaces the marker with the built app bundle', () => {
    const html = `<html><body><div id="root"></div><script nonce="n">${DASHBOARD_APP_MARKER}</script></body></html>`;
    const result = injectDashboardApp(html);
    expect(result).not.toContain(DASHBOARD_APP_MARKER);
    expect(result).toContain('<div id="root"></div>');
    expect(result.length).toBeGreaterThan(dashboardAppJs().length);
  });

  it('reads a non-empty production bundle', () => {
    const bundle = dashboardAppJs();
    expect(bundle.length).toBeGreaterThan(100);
    expect(bundle).toContain('data-karst-dashboard-app');
  });

  it('replaces CSS marker when present', () => {
    const html = `<style>${DASHBOARD_APP_CSS_MARKER}</style><script>${DASHBOARD_APP_MARKER}</script>`;
    const result = injectDashboardApp(html);
    expect(result).not.toContain(DASHBOARD_APP_CSS_MARKER);
    expect(result).toContain(dashboardAppCss());
  });
});
