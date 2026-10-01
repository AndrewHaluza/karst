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
  /**
   * How many one-shot timers are pending in the RENDER realm with a due time
   * within `horizonMs` of now — the realm's own notion of "there is still
   * scheduled work". Intervals are not counted (they never drain); a long
   * watchdog (30 s) falls outside any sane horizon, so what is left at a
   * short horizon is renderer/framework work: React's scheduler flushes
   * through exactly this queue (jsdom has no MessageChannel or setImmediate).
   */
  pendingWorkTimers(horizonMs: number): number;
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
  /** Set by `beforeParse`: reads the realm's pending-timer queue (see below). */
  let pendingWorkProbe: ((horizonMs: number) => number) | null = null;

  const beforeParse = (w: DOMWindow): void => {
    // acquireVsCodeApi — the bridge between the webview script and the host.
    // Throws on second call (NDL-126 §1 requires detecting double-acquisition).
    let acquired = false;
    (w as unknown as Record<string, unknown>).acquireVsCodeApi = () => {
      if (acquired) throw new Error('acquireVsCodeApi() already called');
      acquired = true;
      return {
        postMessage: (msg: unknown) => { posted.push(msg); },
        getState: () => state,
        setState: (s: unknown) => { state = s; },
      };
    };

    // Instrument the realm's one-shot timer queue BEFORE any script runs, so a
    // test can ask "is there still scheduled work in there?" instead of
    // guessing with wall-clock windows (NDL-143 review round 1: settle()
    // determinism). React's scheduler in this realm has no MessageChannel or
    // setImmediate to hide behind — every commit lands through this
    // setTimeout — so an empty horizon IS quiescence.
    const realm = w as unknown as Record<string, unknown>;
    const origSetTimeout = w.setTimeout.bind(w);
    const origClearTimeout = w.clearTimeout.bind(w);
    type Pending = { due: number };
    const pending = new Set<Pending>();
    const byId = new Map<unknown, Pending>();
    realm.setTimeout = ((
      fn: (...args: unknown[]) => void,
      delay?: unknown,
      ...args: unknown[]
    ): unknown => {
      const ms = typeof delay === 'number' && Number.isFinite(delay) && delay >= 0 ? delay : 0;
      const entry: Pending = { due: Date.now() + ms };
      const id = origSetTimeout(
        (...cbArgs: unknown[]) => {
          pending.delete(entry);
          byId.delete(id);
          fn(...cbArgs);
        },
        delay as number | undefined,
        ...args,
      );
      pending.add(entry);
      byId.set(id, entry);
      return id;
    }) as typeof w.setTimeout;
    realm.clearTimeout = ((id?: unknown): void => {
      const entry = id === undefined ? undefined : byId.get(id);
      if (entry) {
        pending.delete(entry);
        byId.delete(id);
      }
      origClearTimeout(id as number | undefined);
    }) as typeof w.clearTimeout;
    realm.__karstPendingWorkTimers = (horizonMs: number): number => {
      const limit = Date.now() + horizonMs;
      let n = 0;
      for (const entry of pending) if (entry.due <= limit) n += 1;
      return n;
    };
    pendingWorkProbe = realm.__karstPendingWorkTimers as (h: number) => number;

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
    pendingWorkTimers(horizonMs: number): number {
      return pendingWorkProbe ? pendingWorkProbe(horizonMs) : 0;
    },
    close() {
      if (closed) return;
      closed = true;
      w.close();
    },
  };

  return handle;
}

/**
 * One turn of the render realm's scheduled-work queue.
 *
 * Real-timer tests: a zero-delay turn of the realm's own event loop.
 * Fake-timer tests: `vi.runAllTimersAsync()` — the harness window's timers are
 * covered by the test's sinon clock, so a bare await of `window.setTimeout`
 * would never resolve (it hangs the mount, which is exactly how the first
 * deterministic draft of `renderWebviewReady` failed).
 *
 * Outside vitest (no module to import) the real-timer path is the only sane
 * answer, so that is what the fallback takes.
 */
export async function pumpRenderRealm(handle: RenderHandle): Promise<void> {
  let vi: any = null;
  try {
    vi = (await import('vitest')).vi;
  } catch {
    // Not running under vitest — real timers only.
  }
  if (vi && vi.isFakeTimers()) {
    await vi.runAllTimersAsync();
    return;
  }
  await new Promise((resolve) => handle.window.setTimeout(resolve, 0));
}

/**
 * Async render for views that set data-karst-ready after React commits.
 * For settings: waits for the flag by draining the render realm's scheduled
 * work, and throws if the realm goes idle without ever setting it (NDL-126 §4).
 * For other views: returns immediately after sync render.
 *
 * The wait used to poll on a wall-clock budget (2 s of 10 ms naps) — another
 * bet on how long the realm takes, and under a loaded suite the bet lost by
 * timing out mid-mount (NDL-143 review round 1). React schedules its commit
 * through the realm's timer queue, so this wait pumps that queue until it is
 * idle: a healthy mount never depends on elapsed time, and an idle-but-never-
 * ready realm (the bundle threw, React never scheduled) fails fast with the
 * realm's own captured errors instead of burning the budget.
 */
export async function renderWebviewReady(name: WebviewName, opts?: { nonce?: string }): Promise<RenderHandle> {
  const handle = renderWebview(name, opts);

  // Only settings uses React; only it should set data-karst-ready.
  // For other views, sync render is complete.
  if (name !== 'settings') return handle;

  // Check if React app is injected (marked by #root element).
  // If not, vanilla view is active — return sync render immediately.
  // If yes, wait for data-karst-ready flag with timeout.
  const hasReactRoot = handle.document.querySelector('#root') !== null;
  if (!hasReactRoot) return handle;

  const WORK_HORIZON_MS = 500;
  const TRIPWIRE_MS = 15_000;
  const startTime = Date.now();
  let idleConfirmations = 0;

  for (;;) {
    if (handle.document.documentElement.hasAttribute('data-karst-ready')) return handle;
    if (Date.now() - startTime > TRIPWIRE_MS) {
      handle.close();
      throw new Error(
        'renderWebviewReady(settings): tripwire — the realm never reached data-karst-ready (React injected)',
      );
    }

    const scheduled = handle.pendingWorkTimers(WORK_HORIZON_MS);
    if (scheduled > 0) {
      // React's commit/effect chain is still scheduled — pump one turn.
      await pumpRenderRealm(handle);
      idleConfirmations = 0;
      continue;
    }

    // The queue looks empty: pump one confirming turn (microtasks and any
    // just-fired zero-delay work flush there) before believing it.
    await pumpRenderRealm(handle);
    if (handle.document.documentElement.hasAttribute('data-karst-ready')) return handle;
    idleConfirmations += 1;
    if (idleConfirmations >= 3) {
      const seen = handle.errors.slice(-3);
      handle.close();
      throw new Error(
        `renderWebviewReady(settings): the render realm went idle without data-karst-ready` +
          (seen.length > 0 ? ` — realm errors: ${seen.join(' | ')}` : ''),
      );
    }
  }
}
