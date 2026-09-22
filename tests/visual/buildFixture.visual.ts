import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { buildFixture } from './buildFixture.js';
import { CHAINS } from './chains.js';
import { THEMES } from './themes.js';

const MARKERS = [
  '/*KARST_DS_CSS*/',
  '/*KARST_DS_JS*/',
  '/*KARST_PALETTE*/',
  '<!--KARST_CSP-->',
] as const;

test.describe('buildFixture', () => {
  const views = Object.keys(CHAINS) as Array<keyof typeof CHAINS>;
  const themeIds = Object.keys(THEMES) as Array<keyof typeof THEMES>;

  for (const view of views) {
    for (const theme of themeIds) {
      test(`${view}/${theme}: produces valid HTML`, () => {
        const html = buildFixture(view, theme, [
          { type: 'state', state: {} },
        ]);

        // (a) The theme's <style> with :root{ comes before the webview's own <style>.
        const themeStyleIdx = html.indexOf('<style nonce="karstvisualnonce">:root{');
        const firstNonThemeStyle = html.indexOf('<style>', html.indexOf(':root{') + 10);
        expect(themeStyleIdx).toBeGreaterThanOrEqual(0);
        // The theme style should appear before any non-theme <style> tag.
        if (firstNonThemeStyle !== -1) {
          expect(themeStyleIdx).toBeLessThan(firstNonThemeStyle);
        }

        // (b) Contains the webview's own content.
        expect(html.length).toBeGreaterThan(1000);

        // (c) Has no unreplaced injection markers.
        for (const marker of MARKERS) {
          expect(html).not.toContain(marker);
        }

        // (d) Contains the CSP <meta> with the fixed nonce.
        expect(html).toContain('nonce="karstvisualnonce"');

        // (e) Contains the acquireVsCodeApi stub (before first <script>) and
        // the seed script with data-karst-ready (before </body>).
        expect(html).toContain('acquireVsCodeApi');
        expect(html).toContain('data-karst-ready');
        // The stub must appear before the first webview <script>.
        const stubIdx = html.indexOf('acquireVsCodeApi');
        const firstScript = html.indexOf('<script', stubIdx + 1);
        expect(stubIdx).toBeLessThan(firstScript);
      });
    }
  }

  test('theme :root block uses concrete hex values', () => {
    const html = buildFixture('dashboard', 'dark', [{ type: 'state', state: {} }]);
    // The theme block should have hex colors, not var() references.
    const rootMatch = html.match(/:root\{([^}]+)\}/);
    expect(rootMatch).not.toBeNull();
    const rootContent = rootMatch![1]!;
    // Should contain hex colors.
    expect(rootContent).toMatch(/#[0-9a-fA-F]{6}/);
  });

  test('seed script dispatches corpus messages', () => {
    const messages = [{ type: 'state', state: { test: true } }];
    const html = buildFixture('gettingStarted', 'dark', messages);
    // The seed script should JSON-serialize the messages.
    expect(html).toContain('"type":"state"');
    expect(html).toContain('MessageEvent');
  });

  test('body class is set by the seed script', () => {
    const html = buildFixture('dashboard', 'light', [{ type: 'state', state: {} }]);
    expect(html).toContain('vscode-light');
  });

  // A corpus containing a literal `</script>` substring (the XSS-probe
  // fixtures do — e.g. sidebar's HOSTILE_LABEL, dashboard's review-findings
  // title) must not be able to terminate the inline seed <script> early.
  // JSON.stringify does not escape `</script>`, so raw interpolation lets it
  // close the tag and the remainder of the JSON renders as page text.
  test('corpus payloads containing "</script>" do not break out of the seed script', () => {
    const messages = [
      { type: 'state', state: { title: '<script>alert(1)</script>' } },
    ];
    const html = buildFixture('dashboard', 'dark', messages);

    // The literal sequence must never appear unescaped inside the page —
    // if it did, the browser would have closed the <script> tag there.
    expect(html).not.toContain('</script>alert');

    // The payload must still be present, just escaped so it stays inside
    // the script's string literal (parses back to the same JS string).
    expect(html).toContain('\\u003c/script>');
  });
});
