/**
 * Shared jsdom render harness for the karst webviews.
 *
 * Why this exists next to the `runInNewContext` harnesses (dashboard, diffs,
 * settings): those use a hand-rolled `document`/`window` double and export
 * internal functions out of the script for direct unit assertions (esc,
 * fileMatches, …).  This harness uses real jsdom: it hydrates through the
 * production injector chain, executes the inline script, and asserts on the
 * rendered DOM — answering "what does the browser see?" rather than "what does
 * the script compute?"  Both are legitimate; they answer different questions.
 * Migrating or deleting the VM harnesses is per-view work in FEAT-37.
 *
 * jsdom CSSOM limits (must be honoured, not fought):
 * - `getComputedStyle` does not resolve `var(--k-*)` or cascade token-valued
 *   properties.  Assert on `document.styleSheets[].cssRules[].selectorText` /
 *   `.style` (declared CSS, which IS populated) and on elements/attributes/
 *   classes.  `getComputedStyle` is only safe where a property is declared
 *   literally on the element.
 * - No `var()` resolution, no `calc()` evaluation, no layout, no real focus
 *   ring, no paint.  Anything needing those is VISUAL and belongs to FEAT-38.
 *
 * xterm is not injected; the dashboard console surface takes its existing
 * missing-vendor degraded path, exactly as the VM harness already does.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { JSDOM, type DOMWindow } from 'jsdom';
import { hydrateWebview, type WebviewName } from '../../model/webviewChains.js';
import { injectCsp, newNonce } from '../../model/csp.js';
import { RUNTIME_ASSETS_ROOT } from '../../runtimeAssetsRoot.js';

const WEBVIEW_ROOT = join(RUNTIME_ASSETS_ROOT, 'ui');

export interface RenderHandle {
  readonly window: DOMWindow;
  readonly document: Document;
  /** Live view of postMessage calls from the webview script. */
  readonly posted: readonly unknown[];
  /** Window 'error' + 'unhandledrejection' messages captured during load. */
  readonly errors: readonly string[];
  /** Last value passed to setState. */
  readonly state: unknown;
  /** Dispatch a MessageEvent on window (simulates host → webview). */
  receive(message: unknown): void;
  /** Click an element by selector; throws if no match. */
  click(selector: string): void;
  /** querySelector shorthand. */
  query<T extends Element = Element>(selector: string): T | null;
  /** querySelectorAll shorthand. */
  queryAll<T extends Element = Element>(selector: string): readonly T[];
  /** Flatten all loaded CSSStyleRules across every stylesheet. */
  cssRules(): readonly CSSStyleRule[];
  /** Idempotent teardown. */
  close(): void;
}

export function renderWebview(name: WebviewName, opts?: { nonce?: string }): RenderHandle {
  const raw = readFileSync(join(WEBVIEW_ROOT, name, 'webview.html'), 'utf8');
  const hydrated = hydrateWebview(name, raw);
  const html = injectCsp(hydrated, opts?.nonce ?? newNonce());

  const posted: unknown[] = [];
  const errors: string[] = [];
  let state: unknown = undefined;

  const beforeParse = (w: DOMWindow): void => {
    // acuateVsCodeApi — the bridge between the webview script and the host.
    (w as unknown as Record<string, unknown>).acquireVsCodeApi = () => ({
      postMessage: (msg: unknown) => { posted.push(msg); },
      getState: () => state,
      setState: (s: unknown) => { state = s; },
    });
    w.addEventListener('error', (e: Event) => {
      const msg = (e as ErrorEvent).message ?? String(e);
      errors.push(msg);
    });
    w.addEventListener('unhandledrejection', (e: Event) => {
      const reason = (e as PromiseRejectionEvent).reason;
      errors.push(reason instanceof Error ? reason.message : String(reason));
    });
  };

  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    beforeParse,
    url: 'https://karst.test/',
  });

  const w = dom.window;
  let closed = false;

  const handle: RenderHandle = {
    window: w,
    document: w.document,
    posted,
    errors,
    get state() { return state; },
    receive(message: unknown) {
      const evt = new w.MessageEvent('message', { data: message });
      w.dispatchEvent(evt);
    },
    click(selector: string) {
      const el = w.document.querySelector<HTMLElement>(selector);
      if (!el) throw new Error(`click: no element matches "${selector}"`);
      el.click();
    },
    query<T extends Element = Element>(selector: string): T | null {
      return w.document.querySelector<T>(selector);
    },
    queryAll<T extends Element = Element>(selector: string): readonly T[] {
      return [...w.document.querySelectorAll<T>(selector)];
    },
    cssRules(): readonly CSSStyleRule[] {
      const rules: CSSStyleRule[] = [];
      for (const sheet of [...w.document.styleSheets]) {
        try {
          for (const rule of [...sheet.cssRules]) {
            if (rule instanceof w.CSSStyleRule) rules.push(rule);
          }
        } catch {
          // Cross-origin or inaccessible sheet — skip.
        }
      }
      return rules;
    },
    close() {
      if (closed) return;
      closed = true;
      w.close();
    },
  };

  return handle;
}
