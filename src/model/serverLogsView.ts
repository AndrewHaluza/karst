/**
 * The SHARED server-logs surface — search, run scoping, clear, ANSI decoding
 * and the control strip rendered by both the in-dashboard logs view and (Task 5)
 * the standalone logs panel. One component, two hosts; a search, a filter or a
 * run scope behaves the same everywhere.
 *
 * The runtime is `window.createServerLogsView({ post, detached, onClose })`:
 *
 *   const view = window.createServerLogsView({ post });
 *   view.open();
 *   view.handleInitial(servers);       // the `server-logs` answer
 *   view.handleOutput(service, text);  // a `server-log-output` chunk
 *   view.clear();                      // drop the rendered lines, keep tailing
 *   view.close();                      // hide the surface
 *
 * A host that needs to clear its own open flag when the surface closes (the
 * dashboard's `logsView`) passes `onClose`; the standalone panel, which has no
 * such flag, lets `close()` post `server-logs-close` itself. `detached: true`
 * omits the "Open in Window" control — the standalone panel has no second
 * window to open.
 *
 * The seven line helpers in `serverLogsView.webview.js` are a VERBATIM mirror of
 * `src/ui/dashboard/logLine.ts` (plus `isRunMarker` from
 * `src/runtime/serverLog.ts`) — the mirrored-constants pattern in
 * `docs/ui/UI-INVARIANTS.md`. The TS module stays the tested source of truth:
 * `webview.test.ts` pins the two decoders together.
 *
 * CSS + JS live in the sibling `serverLogsView.webview.css`/`.webview.js`
 * source files — real CSS/JS a linter, formatter and editor can process,
 * instead of a TS template-literal string — and are read as plain text at call
 * time (the same `readFileSync(join(RUNTIME_ASSETS_ROOT, …))` mechanism
 * `agentPicker.ts` uses; `scripts/copy-assets.mjs` carries both files next to
 * the compiled output), then swapped into each webview's markers
 * (`KARST_SERVER_LOGS_VIEW_CSS` / `KARST_SERVER_LOGS_VIEW_JS`) before
 * `injectCsp` nonces the document. `serverLogsView.webview.js` is never run
 * through a bundler at webview-render time — the runtime text lands verbatim in
 * the document.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RUNTIME_ASSETS_ROOT } from '../runtimeAssetsRoot.js';

/** Placeholder swapped for the logs-view CSS; sits inside each webview's `<style>`. */
export const SERVER_LOGS_VIEW_CSS_MARKER = '/*KARST_SERVER_LOGS_VIEW_CSS*/';

/** Placeholder swapped for the logs-view JS; sits inside each webview's `<script>`. */
export const SERVER_LOGS_VIEW_JS_MARKER = '/*KARST_SERVER_LOGS_VIEW_JS*/';

/**
 * The `.logsview` control-strip + ANSI stylesheet. The shell geometry already
 * lives in the host webview; this carries only the shared surface's own rules,
 * sized with design tokens (UI-R04/R05).
 */
export function serverLogsViewCss(): string {
  return readFileSync(join(RUNTIME_ASSETS_ROOT, 'model/serverLogsView.webview.css'), 'utf8').trim();
}

/**
 * The logs-view runtime. Emitted as plain statements (no wrapping `<script>`
 * tag) so it can be injected as the first lines of an existing block and picked
 * up by `injectCsp`'s nonce pass — the same contract as `agentPickerJs`.
 */
export function serverLogsViewJs(): string {
  return readFileSync(join(RUNTIME_ASSETS_ROOT, 'model/serverLogsView.webview.js'), 'utf8').trim();
}

/** Replace the logs-view CSS/JS markers; no-op per marker if absent. */
export function injectServerLogsView(html: string): string {
  return html
    .replace(SERVER_LOGS_VIEW_CSS_MARKER, () => serverLogsViewCss())
    .replace(SERVER_LOGS_VIEW_JS_MARKER, () => serverLogsViewJs());
}
