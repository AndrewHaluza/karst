/**
 * NDL-39 ratchet: the dashboard and settings webviews may only post host
 * messages through the type-checked `karstSend` senders.
 *
 * A raw `post({...})` / `vscode.postMessage(...)` in either HTML re-opens the
 * silent-drop hole this work closed — the message would be unchecked JS. This
 * test pins the wiring and the one-acquire rule structurally, so a regression
 * fails in CI rather than in the extension host.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSender as createDashboardSender } from './dashboard/webviewSend.js';
import { createSender as createSettingsSender } from './settings/webviewSend.js';
import { hydrateWebview } from '../model/webviewChains.js';

const SRC = dirname(fileURLToPath(import.meta.url));

const CASES = [
  {
    view: 'dashboard' as const,
    html: readFileSync(join(SRC, 'dashboard', 'webview.html'), 'utf8'),
    marker: '/*KARST_WEBVIEW_SEND_DASHBOARD*/',
    keys: Object.keys(createDashboardSender({ postMessage: () => {} })),
  },
  {
    view: 'settings' as const,
    html: readFileSync(join(SRC, 'settings', 'webview.html'), 'utf8'),
    marker: '/*KARST_WEBVIEW_SEND_SETTINGS*/',
    keys: Object.keys(createSettingsSender({ postMessage: () => {} })),
  },
];

function usedSenders(html: string): readonly string[] {
  return [...html.matchAll(/karstSend\.([A-Za-z0-9_]+)/g)].map((m) => m[1]!);
}

describe('webview send contract ratchet', () => {
  it.each(CASES)('$view HTML posts only through karstSend', ({ html }) => {
    expect(html).not.toMatch(/vscode\.postMessage\s*\(/);
    // Any bare `post(...)` (the deleted HTML helper) would be unchecked JS.
    expect(html).not.toMatch(/\bpost\s*\(/);
  });

  it.each(CASES)('$view HTML uses only senders createSender defines', ({ html, keys }) => {
    const used = usedSenders(html);
    expect(used.length).toBeGreaterThan(0);
    for (const name of used) {
      expect(keys, `karstSend.${name} is not a createSender function`).toContain(name);
    }
  });

  it.each(CASES)('$view HTML carries the sender marker and no acquire call', ({ html, marker }) => {
    expect(html).toContain(marker);
    // The only acquire lives in the generated bundle, not the authored HTML.
    expect(html).not.toContain('acquireVsCodeApi');
  });

  it.each(CASES)('$view renders exactly one acquireVsCodeApi', ({ view, html, marker }) => {
    const rendered = hydrateWebview(view, html);
    expect(rendered).not.toContain(marker);
    expect(rendered.match(/acquireVsCodeApi/g) ?? []).toHaveLength(1);
  });
});
