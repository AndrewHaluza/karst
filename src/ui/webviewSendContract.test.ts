/**
 * NDL-39 ratchet: the webviews may only post host messages through the
 * type-checked `karstSend` senders.
 *
 * A raw `post({...})` / `vscode.postMessage(...)` re-opens the silent-drop hole
 * this work closed — the message would be unchecked JS. This test pins the
 * wiring and the one-acquire rule structurally, so a regression fails in CI
 * rather than in the extension host.
 *
 * The two views post through DIFFERENT media since phase 4:
 *
 * - Dashboard HTML still calls `karstSend.<name>(…)` directly, so the HTML
 *   itself is the typed surface (the sender marker is injected with the bundle).
 * - Settings posts through the React app: the sender bundle was folded into the
 *   app bundle (`app/main.tsx` imports `webviewSend.ts`, is the document's one
 *   `acquireVsCodeApi()` caller, and publishes `vscode`/`karstSend` globals the
 *   app reads). The shell HTML therefore contains no `karstSend.` calls at all —
 *   the guarantee moved to the app source, which is checked below against the
 *   SAME `createSender` function table.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSender as createDashboardSender } from './dashboard/webviewSend.js';
import { createSender as createSettingsSender } from './settings/webviewSend.js';
import { hydrateWebview } from '../model/webviewChains.js';

const SRC = dirname(fileURLToPath(import.meta.url));

const DASHBOARD = {
  view: 'dashboard' as const,
  html: readFileSync(join(SRC, 'dashboard', 'webview.html'), 'utf8'),
  marker: '/*KARST_WEBVIEW_SEND_DASHBOARD*/',
};

const SETTINGS = {
  view: 'settings' as const,
  html: readFileSync(join(SRC, 'settings', 'webview.html'), 'utf8'),
};

/** The settings app's `send.*` call sites, one per outbound function used. */
function appUsedSenders(): readonly string[] {
  const files = [...walk(join(SRC, 'settings', 'app'))].filter((f) =>
    f.endsWith('.ts') || f.endsWith('.tsx'),
  );
  const used = new Set<string>();
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(/\.(save|validate|validateProcessAssignments|installApproach|uninstallApproach|setToken|clearToken|setApproachEnabled|setAgentEnabled|saveAgentFile|createAgent|deleteAgent|requestState|getApproachCommandBody|fetchTicketStatuses|fetchTicketLists|browseRepoPath|openManifest|openGraphPrompt)\(/g)) {
      used.add(m[1]!);
    }
  }
  return [...used];
}

function walk(dir: string): readonly string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

describe('webview send contract ratchet — dashboard HTML', () => {
  it('posts only through karstSend', () => {
    expect(DASHBOARD.html).not.toMatch(/vscode\.postMessage\s*\(/);
    // Any bare `post(...)` (the deleted HTML helper) would be unchecked JS.
    expect(DASHBOARD.html).not.toMatch(/\bpost\s*\(/);
  });

  it('uses only senders createSender defines', () => {
    const used = [...DASHBOARD.html.matchAll(/karstSend\.([A-Za-z0-9_]+)/g)].map((m) => m[1]!);
    expect(used.length).toBeGreaterThan(0);
    const keys = Object.keys(createDashboardSender({ postMessage: () => {} }));
    for (const name of used) {
      expect(keys, `karstSend.${name} is not a createSender function`).toContain(name);
    }
  });

  it('carries the sender marker and no acquire call', () => {
    expect(DASHBOARD.html).toContain(DASHBOARD.marker);
    // The only acquire lives in the generated bundle, not the authored HTML.
    expect(DASHBOARD.html).not.toContain('acquireVsCodeApi');
  });

  it('renders exactly one acquireVsCodeApi', () => {
    const rendered = hydrateWebview(DASHBOARD.view, DASHBOARD.html);
    expect(rendered).not.toContain(DASHBOARD.marker);
    expect(rendered.match(/acquireVsCodeApi/g) ?? []).toHaveLength(1);
  });
});

describe('webview send contract ratchet — settings app', () => {
  it('shell HTML carries the app marker and posts nothing raw', () => {
    expect(SETTINGS.html).toContain('/*KARST_SETTINGS_APP*/');
    expect(SETTINGS.html).not.toContain('/*KARST_WEBVIEW_SEND_SETTINGS*/');
    expect(SETTINGS.html).not.toMatch(/vscode\.postMessage\s*\(/);
    expect(SETTINGS.html).not.toMatch(/\bpost\s*\(/);
    // The shell is a shell: no vanilla inline logic survives the switch-over.
    expect(SETTINGS.html).not.toContain('karstSend.');
    // The only acquire lives in the generated app bundle, not the authored HTML.
    expect(SETTINGS.html).not.toContain('acquireVsCodeApi');
  });

  it('app call sites use only senders createSender defines', () => {
    const keys = Object.keys(createSettingsSender({ postMessage: () => {} }));
    const used = appUsedSenders();
    expect(used.length).toBeGreaterThan(0);
    for (const name of used) {
      expect(keys, `send.${name} is not a createSender function`).toContain(name);
    }
  });

  it('renders exactly one acquireVsCodeApi', () => {
    const rendered = hydrateWebview(SETTINGS.view, SETTINGS.html);
    expect(rendered).not.toContain('/*KARST_SETTINGS_APP*/');
    expect(rendered.match(/acquireVsCodeApi/g) ?? []).toHaveLength(1);
  });
});