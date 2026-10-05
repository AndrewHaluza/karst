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

  // The old assertion here was `expect(html).toContain('vscode-light')`, which
  // the injected palette CSS satisfies on its own — the literal string
  // `body.vscode-light{...}` is in every fixture regardless of whether the
  // class ever reaches the element. Seven of the nine webview fragments carry
  // no `<body>` tag, so gating the injection on one silently skipped them and
  // they rendered :root's dark stage palette in every theme (NDL-219). Assert
  // the assignment itself, that it exists for both markup shapes, and that it
  // runs before readiness so nothing paints unthemed.
  test('body class script is emitted unconditionally, before data-karst-ready', () => {
    const lightClass =
      'vscode-light vscode-theme-defaults-themes-light_modern-json';
    const hcClass = 'vscode-high-contrast vscode-theme-defaults-themes-hc_black-json';

    // dashboard's markup has no <body> tag — the case that used to be skipped.
    const noBodyTag = buildFixture('dashboard', 'light', [{ type: 'state', state: {} }]);
    expect(noBodyTag).not.toMatch(/<body[\s>]/i);
    expect(noBodyTag).toContain(`document.body.className="${lightClass}"`);

    // diffs does carry a <body> tag and must keep the same script.
    const withBodyTag = buildFixture('diffs', 'hc', [{ type: 'state', state: {} }]);
    expect(withBodyTag).toMatch(/<body[\s>]/i);
    expect(withBodyTag).toContain(`document.body.className="${hcClass}"`);

    for (const html of [noBodyTag, withBodyTag]) {
      const assign = html.indexOf('document.body.className=');
      expect(assign).toBeGreaterThanOrEqual(0);
      // The class must be on <body> before the seed dispatches a message and
      // before it sets data-karst-ready — never after.
      expect(assign).toBeLessThan(html.indexOf('data-karst-ready'));
    }
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
