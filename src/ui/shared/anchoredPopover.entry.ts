/**
 * Bundle entry for the vanilla webviews (the ticket form): exposes the shared placement primitive as the page global
 * `karstAnchoredPopover`, so a page that cannot import TS places its popovers with the same code the React views use.
 * esbuild bundles this file to `ui/shared/anchoredPopover.webview.js` (`scripts/build-webview-send.mjs`).
 */
import { attachAnchoredPopover } from './anchoredPopover.js';

const globals = globalThis as unknown as { karstAnchoredPopover: { attach: typeof attachAnchoredPopover } };
globals.karstAnchoredPopover = { attach: attachAnchoredPopover };
