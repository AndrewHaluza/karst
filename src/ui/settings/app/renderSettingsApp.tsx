/**
 * A rendered-Settings test through `renderWebviewReady` against the app the
 * production chain now mounts (NDL-126 §9.5).
 *
 * Since phase 4 the settings webview IS the React app: `webview.html` carries
 * the `KARST_SETTINGS_APP` marker, the injector chain replaces it with the
 * bundled app, and `main.tsx` renders into `#root`. So this helper is a thin
 * adapter over the harness handle, not a second mount — `renderWebviewReady`
 * already did the mounting.
 *
 * The harness's `acquireVsCodeApi` double IS the app's real I/O channel, so
 * `posted` / `state` / `receive` here read straight through it:
 * - `posted` collects every outbound `postMessage` (the same messages the
 *   extension host would receive);
 * - `receive(message)` dispatches a window `MessageEvent` the app's
 *   `pageHostBridge.subscribe` listener picks up — exactly the host→webview
 *   path;
 * - `state` is the last `setState`.
 *
 * RUNTIME assertions then read the rendered DOM (dirty markers, aria state,
 * banners, live region) exactly as a user sees them. The earlier
 * manually-mounted probe that serialised reducer internals is gone with the
 * phase-3 helper: the reducer's own suite covers those derivations.
 */
import {
  drainReactWork,
  renderWebviewReady,
  waitForSettingsReady,
  type RenderHandle,
} from '../../testing/renderHarness.js';
import type { SettingsHostMessage, SettingsWebviewMessage } from '../messages.js';

/** One outbound message, including the async-action correlation id (UI-R13). */
export type Outbound = SettingsWebviewMessage & { requestId?: string };

export interface RenderedSettings extends RenderHandle {
  /** Push a host message at the app and let React commit. */
  receive(message: SettingsHostMessage): Promise<void>;
  /** Let React commit anything queued (effects, transitions). */
  settle(): Promise<void>;
  /**
   * Click a control inside the React tree and let React commit. Wrapping the
   * activation in `act` is what makes the pending state observable synchronously
   * — UI-R11 is precisely the claim that pending is set on activation, before
   * any host result can arrive, and an unwrapped DOM click would not show it.
   */
  click(target: Element | string): Promise<void>;
  /** Focus an element inside the React tree (for focus assertions). */
  focus(target: Element): Promise<void>;
  /** Every message the app posted, oldest first. */
  readonly posted: readonly Outbound[];
  /** Every outbound message of `type`, in order. */
  all(type: SettingsWebviewMessage['type']): readonly Outbound[];
  /** The most recent outbound message of `type`, or `undefined`. */
  last(type: SettingsWebviewMessage['type']): Outbound | undefined;
  /** What the app persisted through the page's `setState`. */
  readonly state: unknown;
}

/**
 * The file-wide jsdom realm, reused across a test file's mounts.
 *
 * Booting the full settings document — jsdom parsing ~1 MB of injected React
 * bundle plus the shared runtimes, then executing it — costs the better part of
 * a second, and every rendered test used to pay it. The realm is created once
 * and each subsequent `renderSettingsApp` reboots the SAME realm: the old
 * bridge is neutralized, `data-karst-ready`/`#root` are reset, and the page
 * script runs again. A fresh React app therefore starts from the initial state
 * every time, while the expensive document parse happens once per file.
 *
 * `closeSettingsRealm` (an `afterAll`) tears the realm down; a view's `close()`
 * is intentionally a no-op so an `afterEach` cannot kill the shared realm
 * mid-file.
 */
let sharedRealm: RenderHandle | null = null;

async function currentRealm(): Promise<RenderHandle> {
  if (sharedRealm) {
    sharedRealm.resetRealm();
    const script = sharedRealm.pageScript;
    if (!script) throw new Error('renderSettingsApp: the settings page has no re-runnable script');
    (sharedRealm.window as unknown as { eval(code: string): unknown }).eval(script);
    await waitForSettingsReady(sharedRealm);
    return sharedRealm;
  }
  sharedRealm = await renderWebviewReady('settings');
  return sharedRealm;
}

/** Tear down the shared realm. Call from `afterAll`, never per test. */
export function closeSettingsRealm(): void {
  sharedRealm?.close();
  sharedRealm = null;
}

export async function renderSettingsApp(): Promise<RenderedSettings> {
  const handle = await currentRealm();

  const posted = handle.posted as readonly Outbound[];
  const settle = async (): Promise<void> => {
    const { vi } = await import('vitest');
    if (vi && vi.isFakeTimers()) {
      await vi.runAllTimersAsync();
    } else {
      await drainReactWork(handle);
    }
    await Promise.resolve();
    await Promise.resolve();
  };

  return {
    window: handle.window,
    document: handle.document,
    errors: handle.errors,
    get posted() {
      return posted;
    },
    get state() {
      return handle.state;
    },
    all: (type) => posted.filter((m) => m.type === type),
    last: (type) => [...posted].reverse().find((m) => m.type === type),
    async receive(message: SettingsHostMessage) {
      handle.receive(message);
      await settle();
    },
    settle,
    async click(target: Element | string) {
      const node = typeof target === 'string' ? inRoot(handle, target) : target;
      node.dispatchEvent(
        new (handle.window.MouseEvent)('click', { bubbles: true, cancelable: true }),
      );
      await settle();
    },
    async focus(target: Element) {
      target.dispatchEvent(new (handle.window.FocusEvent)('focus'));
      await settle();
    },
    query: handle.query,
    queryAll: handle.queryAll,
    cssRules: handle.cssRules,
    pendingWorkTimers: (horizonMs: number) => handle.pendingWorkTimers(horizonMs),
    pageScript: handle.pageScript,
    resetRealm: () => handle.resetRealm(),
    close: () => {
      // The realm is shared across the file; a per-test close would tear down
      // the realm the NEXT test reboots. `closeSettingsRealm` owns teardown.
    },
  };
}

/**
 * Resolve a selector inside the React tree, or throw with it.
 *
 * Through the harness handle's own `query` rather than a bare document lookup:
 * `document.querySelector` is banned across the app by R09b, and reaching around
 * the harness here would put it back.
 */
function inRoot(handle: RenderHandle, selector: string): Element {
  const node = handle.query('[id="root"]')?.querySelector(selector);
  if (!node) throw new Error(`no element matches "${selector}" inside the React tree`);
  return node;
}

