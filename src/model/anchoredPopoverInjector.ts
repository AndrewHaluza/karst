/**
 * Inject the pre-built shared popover placement bundle into a vanilla webview document.
 *
 * `src/ui/shared/anchoredPopover.ts` is bundled by esbuild (`scripts/build-webview-send.mjs`) and read as plain text
 * through `RUNTIME_ASSETS_ROOT`, the same mechanism the sender bundles use. A document without the marker is returned
 * unchanged; when the marker IS present the bundle must exist, so a missing bundle THROWS.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RUNTIME_ASSETS_ROOT } from '../runtimeAssetsRoot.js';

/** Marker in a vanilla webview's inline script. */
export const ANCHORED_POPOVER_MARKER = '/*KARST_ANCHORED_POPOVER_JS*/';

/** The placement bundle text, read from the runtime assets root. */
export function anchoredPopoverJs(): string {
  return readFileSync(join(RUNTIME_ASSETS_ROOT, 'ui/shared/anchoredPopover.webview.js'), 'utf8').trim();
}

/** Replace the marker with the bundle. A document without the marker is returned unchanged. */
export function injectAnchoredPopover(html: string): string {
  if (!html.includes(ANCHORED_POPOVER_MARKER)) return html;
  return html.replace(ANCHORED_POPOVER_MARKER, () => anchoredPopoverJs());
}
