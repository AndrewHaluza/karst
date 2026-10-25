import { describe, expect, it } from 'vitest';
import { SIDEBAR_APP_MARKER, injectSidebarApp, sidebarAppJs } from './sidebarAppInjector.js';

describe('injectSidebarApp', () => {
  it('returns a document without the marker unchanged', () => {
    const html = '<html><body><div id="root"></div></body></html>';
    expect(injectSidebarApp(html)).toBe(html);
  });

  it('replaces the marker with the built app bundle, once', () => {
    const html = `<html><body><div id="root"></div><script nonce="n">${SIDEBAR_APP_MARKER}</script></body></html>`;
    const result = injectSidebarApp(html);
    expect(result).not.toContain(SIDEBAR_APP_MARKER);
    expect(result).toContain('<div id="root"></div>');
    expect(result.length).toBeGreaterThan(sidebarAppJs().length);
  });

  it('reads a non-empty bundle that is the sidebar app and calls acquireVsCodeApi exactly once', () => {
    const bundle = sidebarAppJs();
    expect(bundle.length).toBeGreaterThan(100);
    expect(bundle).toContain('Search tickets and plans');
    expect(bundle.match(/acquireVsCodeApi\(/g)).toHaveLength(1);
  });

  it('keeps a "$&" in the bundle literal (replacement is by function, not pattern)', () => {
    const result = injectSidebarApp(`<script>${SIDEBAR_APP_MARKER}</script>`);
    expect(result).toBe(`<script>${sidebarAppJs()}</script>`);
  });
});
