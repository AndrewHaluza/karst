/**
 * The visual sweep's view→injector-chain table.
 *
 * Re-exports the chain table from `src/model/webviewChains.ts` (the single
 * source of truth for production injector chains) and augments each entry with
 * the path to its `webview.html` file.  The `render` functions call the REAL
 * injector functions — never reimplement them — so the fixture pages depict
 * what ships.
 *
 * If FEAT-36 delivers its own chain-table module, this file becomes a
 * one-line re-export of that module.  For now it is the temporary owner.
 *
 * `injectCsp` is called with a FIXED nonce constant (not `newNonce()`) because
 * a random nonce changes the HTML on every run and would be a permanent diff.
 * `injectXterm` is NOT called for dashboard — the terminal region is masked
 * in the screenshot (D12).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  WEBVIEW_NAMES,
  WEBVIEW_CHAINS,
  type WebviewName,
} from '../../src/model/webviewChains.js';
import { injectCsp } from '../../src/model/csp.js';

export type ViewId = WebviewName;

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC_UI = join(HERE, '..', '..', 'src', 'ui');

/** Fixed nonce — never random, to keep HTML deterministic across runs. */
const FIXED_NONCE = 'karstvisualnonce';

export interface ViewChain {
  readonly htmlPath: string;
  readonly render: (html: string) => string;
}

/**
 * Per-view chain table: htmlPath for reading the raw HTML, render for
 * hydrating it through the real injector chain + fixed-nonce CSP.
 */
export const CHAINS: Readonly<Record<ViewId, ViewChain>> = Object.fromEntries(
  WEBVIEW_NAMES.map((name) => {
    const htmlPath = join(SRC_UI, name, 'webview.html');
    const chain = WEBVIEW_CHAINS[name];
    if (!chain) throw new Error(`No chain for ${name}`);
    return [
      name,
      {
        htmlPath,
        render: (html: string): string => injectCsp(chain(html), FIXED_NONCE),
      },
    ] as const;
  }),
) as Readonly<Record<ViewId, ViewChain>>;

/** Read the raw HTML for a view. */
export function readHtml(view: ViewId): string {
  const entry = CHAINS[view];
  if (!entry) throw new Error(`Unknown view: ${view}`);
  return readFileSync(entry.htmlPath, 'utf8');
}

/** Hydrate a view's raw HTML through its full injector chain + CSP. */
export function renderView(view: ViewId): string {
  return CHAINS[view]!.render(readHtml(view));
}
