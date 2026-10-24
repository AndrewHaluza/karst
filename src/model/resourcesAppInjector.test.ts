import { describe, expect, it } from 'vitest';
import {
  RESOURCES_APP_CSS_MARKER,
  RESOURCES_APP_MARKER,
  injectResourcesApp,
  resourcesAppCss,
  resourcesAppJs,
} from './resourcesAppInjector.js';

describe('injectResourcesApp', () => {
  it('returns a document without the marker unchanged', () => {
    const html = '<html><body><div id="root"></div></body></html>';
    expect(injectResourcesApp(html)).toBe(html);
  });

  it('replaces the marker with the built app bundle, once', () => {
    const html = `<html><body><div id="root"></div><script nonce="n">${RESOURCES_APP_MARKER}</script></body></html>`;
    const result = injectResourcesApp(html);
    expect(result).not.toContain(RESOURCES_APP_MARKER);
    expect(result).toContain('<div id="root"></div>');
    expect(result.length).toBeGreaterThan(resourcesAppJs().length);
  });

  it('reads a non-empty production bundle that is the resources app', () => {
    const bundle = resourcesAppJs();
    expect(bundle.length).toBeGreaterThan(100);
    expect(bundle).toContain('Servers');
    expect(bundle).toContain('tablist');
  });

  it('keeps a "$&" in the bundle literal (replacement is by function, not pattern)', () => {
    const result = injectResourcesApp(`<script>${RESOURCES_APP_MARKER}</script>`);
    expect(result).toBe(`<script>${resourcesAppJs()}</script>`);
  });

  it('replaces the stylesheet marker with the Servers sheet', () => {
    const result = injectResourcesApp(`<style>${RESOURCES_APP_CSS_MARKER}</style><script>${RESOURCES_APP_MARKER}</script>`);
    expect(result).not.toContain(RESOURCES_APP_CSS_MARKER);
    expect(result).toContain(resourcesAppCss());
    expect(resourcesAppCss()).toContain('.srow');
  });
});
