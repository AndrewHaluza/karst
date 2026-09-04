import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The one stable anchor for `readFileSync(join(RUNTIME_ASSETS_ROOT, <src-relative
 * path>))` reads of non-TS runtime assets (`webview.html`, and the webview
 * CSS/JS that lives as a real sibling `.css`/`.js` source file instead of a TS
 * template-literal string — see `agentPicker.ts`, `designComponents.ts`,
 * `designRuntime.ts`, `tablerIcons.ts`).
 *
 * This file sits at the SRC ROOT, the same depth as `extension.ts`, on
 * purpose: `dirname(fileURLToPath(import.meta.url))` resolves correctly in
 * both places this ever runs from —
 *
 *  - unbundled (`vitest`/`tsc`): resolves to `src/`, this file's own
 *    directory, matching `scripts/copy-assets.mjs`'s SOURCE tree.
 *  - bundled (`dist/extension.js`, one file via esbuild): `import.meta.url`
 *    collapses to the bundle's own location for every module inside it —
 *    `dist/`, matching `scripts/copy-assets.mjs`'s DESTINATION tree.
 *
 * A module living deeper than the src root (e.g. `src/model/agentPicker.ts`)
 * canNOT derive this by computing its OWN `import.meta.url`: unbundled that
 * gives `src/model/` (one level too deep), while bundled it gives the same
 * collapsed `dist/` as everything else — two different answers depending on
 * environment for the SAME relative-path arithmetic. Importing this root and
 * joining the full src-relative path (`model/agentPicker.webview.css`) from
 * it is what makes the same join expression correct in both.
 */
export const RUNTIME_ASSETS_ROOT = dirname(fileURLToPath(import.meta.url));
