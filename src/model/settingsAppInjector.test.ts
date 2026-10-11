import { describe, expect, it } from 'vitest';
import {
  SETTINGS_APP_MARKER,
  injectSettingsApp,
  settingsAppCss,
  settingsAppJs,
} from './settingsAppInjector.js';

describe('injectSettingsApp (NDL-126 §1)', () => {
  it('returns a document without the marker unchanged (vanilla view stays live)', () => {
    const html = '<html><body><div id="root"></div></body></html>';
    expect(injectSettingsApp(html)).toBe(html);
  });

  it('replaces the marker with the built app bundle', () => {
    const html = `<html><body><div id="root"></div><script nonce="n">${SETTINGS_APP_MARKER}</script></body></html>`;
    const result = injectSettingsApp(html);
    expect(result).not.toContain(SETTINGS_APP_MARKER);
    expect(result).toContain('<div id="root"></div>');
    // The bundle is a self-contained IIFE, not an empty placeholder.
    expect(result.length).toBeGreaterThan(settingsAppJs().length);
  });

  it('reads a non-empty production bundle', () => {
    const bundle = settingsAppJs();
    expect(bundle.length).toBeGreaterThan(1000);
    expect(bundle).toContain('data-karst-ready');
  });

  it('ships the shared sheet followed by the Agents page sheet', () => {
    const css = settingsAppCss();
    expect(css).toContain('.cap-value');
    expect(css.indexOf('#section-agents')).toBeGreaterThan(css.indexOf('.cap-value'));
  });
});
