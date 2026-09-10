/**
 * Builds fixture HTML pages for the visual sweep.
 *
 * Each page is a full HTML document that:
 * 1. Prepends the theme's `:root` block BEFORE the webview's own `<style>`
 *    (so the webview's rules and the injected palette still win the cascade).
 * 2. Runs the real injector chain (through `CHAINS[view].render`).
 * 3. Appends a nonced `<script>` that stubs `acquireVsCodeApi()` and
 *    dispatches the corpus payload as a `message` event.
 * 4. Sets `data-karst-ready` after dispatching, so the test helper knows
 *    when the page is rendered.
 *
 * The seed MUST use the view's real message protocol (from its `messages.ts`).
 * The stub `acquireVsCodeApi()` provides `postMessage`, `getState`, and
 * `setState` — the page must never try to reach a real host.
 */
import { readFileSync, mkdirSync, writeFileSync, cpSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHAINS, type ViewId } from './chains.js';
import { THEMES, type ThemeId, THEME_IDS } from './themes.js';
import { getCorpus, dashboardCorpora, ALL_VIEWS } from './corpora.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(HERE, '.tmp');
const CATALOG_SRC = join(HERE, '..', '..', 'docs', 'ui', 'KARST-UI-CATALOG.html');

/** Fixed nonce matching the one used in chains.ts. */
const FIXED_NONCE = 'karstvisualnonce';

/**
 * Build a complete fixture HTML page for one view + theme.
 *
 * @param view - The view id
 * @param theme - The theme id
 * @param corpusMessages - The messages to dispatch (array of postMessage payloads)
 * @returns Complete HTML document
 */
export function buildFixture(
  view: ViewId,
  theme: ThemeId,
  corpusMessages: readonly unknown[],
): string {
  const entry = CHAINS[view];
  if (!entry) throw new Error(`Unknown view: ${view}`);

  const themeData = THEMES[theme];
  if (!themeData) throw new Error(`Unknown theme: ${theme}`);

  // Read the raw HTML and hydrate through the real injector chain + CSP.
  const raw = readFileSync(entry.htmlPath, 'utf8');
  const hydrated = entry.render(raw);

  // Build the seed script: stubs acquireVsCodeApi and dispatches corpus messages.
  const seedScript = buildSeedScript(view, corpusMessages);

  // The theme <style> must come BEFORE the webview's own <style> blocks.
  // We insert it right after <head> (or at the start of <body> if no <head>).
  // The webview's own <style> and the injected palette come after, winning
  // the cascade exactly as they do in VS Code.
  const themeStyle = `<style nonce="${FIXED_NONCE}">${themeData.rootCss}</style>`;

  // Insert the theme style and seed script.
  let html = hydrated;

  // Insert theme style BEFORE the first <style> tag, so the theme's :root
  // block is defined before any webview styles or injected design system CSS.
  const firstStyleIdx = html.indexOf('<style');
  if (firstStyleIdx !== -1) {
    html = html.slice(0, firstStyleIdx) + themeStyle + '\n' + html.slice(firstStyleIdx);
  } else {
    html = themeStyle + '\n' + html;
  }

  // The acquireVsCodeApi stub MUST go before the first <script> tag because
  // the webview's own script calls it immediately.  Insert it after <head>.
  const vsApiStub = buildVsApiStub();
  const firstScriptIdx = html.indexOf('<script');
  if (firstScriptIdx !== -1) {
    html = html.slice(0, firstScriptIdx) + vsApiStub + '\n' + html.slice(firstScriptIdx);
  } else {
    html += '\n' + vsApiStub;
  }

  // Set body class for the theme.
  const bodyClassScript = `<script nonce="${FIXED_NONCE}">document.body.className=${JSON.stringify(themeData.bodyClass)};</script>`;

  // Insert body class script right after <body> tag.
  const bodyMatch = html.match(/<body[^>]*>/i);
  if (bodyMatch) {
    const insertPos = html.indexOf(bodyMatch[0]) + bodyMatch[0].length;
    html = html.slice(0, insertPos) + '\n' + bodyClassScript + html.slice(insertPos);
  }

  // Append the message dispatch + readiness signal before </body>.
  const bodyClose = html.lastIndexOf('</body>');
  if (bodyClose !== -1) {
    html = html.slice(0, bodyClose) + seedScript + '\n' + html.slice(bodyClose);
  } else {
    html += '\n' + seedScript;
  }

  return html;
}

/**
 * Build the acquireVsCodeApi stub — must run before the webview's own script.
 */
function buildVsApiStub(): string {
  return `<script nonce="${FIXED_NONCE}">
(function() {
  window.acquireVsCodeApi = function() {
    return {
      postMessage: function() {},
      getState: function() { return undefined; },
      setState: function() {}
    };
  };
})();
</script>`;
}

/**
 * Build the inline script that dispatches corpus messages and signals readiness.
 * The acquireVsCodeApi stub is separate (buildVsApiStub) and runs earlier.
 */
function buildSeedScript(
  view: ViewId,
  corpusMessages: readonly unknown[],
): string {
  const messagesJson = JSON.stringify(corpusMessages);

  return `<script nonce="${FIXED_NONCE}">
(function() {
  // Dispatch each corpus message as a MessageEvent.
  var msgs = ${messagesJson};
  for (var i = 0; i < msgs.length; i++) {
    window.dispatchEvent(new MessageEvent('message', { data: msgs[i] }));
  }
  // Signal readiness for the test helper.
  document.documentElement.setAttribute('data-karst-ready', '1');
})();
</script>`;
}

/**
 * Write all fixture pages to the output directory.
 *
 * Structure: `<outDir>/<theme>/<view>.html` for every (view, theme) pair,
 * plus a copy of the catalog page at `<outDir>/catalog.html`.
 *
 * For dashboard, iterates over all 6 scenarios (one page per scenario per theme).
 */
export function writeFixtures(outDir: string = OUT_DIR): void {
  mkdirSync(outDir, { recursive: true });

  for (const theme of THEME_IDS) {
    const themeDir = join(outDir, theme);
    mkdirSync(themeDir, { recursive: true });

    for (const view of ALL_VIEWS) {
      if (view === 'dashboard') {
        // Dashboard: one page per scenario.
        const corpora = dashboardCorpora();
        for (const { scenario, corpus } of corpora) {
          const html = buildFixture(view, theme, corpus.messages);
          const filename = `dashboard-${scenario}.html`;
          writeFileSync(join(themeDir, filename), html, 'utf8');
        }
      } else {
        const corpus = getCorpus(view);
        const html = buildFixture(view, theme, corpus.messages);
        writeFileSync(join(themeDir, `${view}.html`), html, 'utf8');
      }
    }
  }

  // Copy the catalog page.
  try {
    const catalog = readFileSync(CATALOG_SRC, 'utf8');
    writeFileSync(join(outDir, 'catalog.html'), catalog, 'utf8');
  } catch {
    // Catalog may not exist yet — skip silently.
  }
}
