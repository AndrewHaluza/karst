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
import { pumpRenderRealm, renderWebviewReady, type RenderHandle } from '../../testing/renderHarness.js';
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

export async function renderSettingsApp(): Promise<RenderedSettings> {
  const handle = await renderWebviewReady('settings');

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
    close: () => {
      handle.close();
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

/**
 * Wait until the app realm has no scheduled work left — deterministically.
 *
 * The app runs inside the harness's JSDOM realm, so the test realm's `act`
 * cannot flush it: React's commits land asynchronously through the realm's own
 * `setTimeout` queue (jsdom has no MessageChannel or setImmediate for the
 * scheduler to prefer). A wall-clock wait — 10 ms fixed, or a mutation-quiet
 * window — is a bet on how long that queue takes, and under a loaded suite the
 * bet loses (NDL-143 review round 1: the quiet-window variant still lost
 * ~2 assertions per 7 full-suite runs).
 *
 * So don't bet: `renderWebview` instruments the realm's one-shot timers in
 * `beforeParse`, and this drain PUMPS the realm (`pumpRenderRealm` — a real
 * timer turn, or `vi.runAllTimersAsync` when the test's sinon clock covers the
 * realm) and asks whether ANY timer is due within `WORK_HORIZON_MS`. React's
 * flush hops are due immediately, so while work is queued the answer is yes
 * and the drain keeps pumping; the exit condition — empty horizon after two
 * consecutive pumps — is quiescence, not an estimate. Work landing later than
 * the horizon would have to be a deliberately delayed timer, and the app's only
 * long timers (the 30 s mutation watchdog, the 2 s saved-ack) sit far outside
 * it; starvation delays FIRING, never the due time, so a loaded machine cannot
 * push a queued hop out of the horizon.
 *
 * The budget is a tripwire, not a wait: a realm that never quiesces is a bug
 * and must fail loudly instead of resolving early into the same race.
 */
const WORK_HORIZON_MS = 500;
const QUIESCE_BUDGET_MS = 5_000;

async function drainReactWork(handle: RenderHandle): Promise<void> {
  const start = Date.now();
  let emptyPumps = 0;
  for (;;) {
    await pumpRenderRealm(handle);
    if (handle.pendingWorkTimers(WORK_HORIZON_MS) === 0) {
      emptyPumps += 1;
      // Effects of the commit that just ran may queue more work synchronously;
      // a second consecutive empty pump means the queue actually stayed empty.
      if (emptyPumps >= 2) return;
    } else {
      emptyPumps = 0;
    }
    if (Date.now() - start > QUIESCE_BUDGET_MS) {
      throw new Error(
        `renderSettingsApp.settle: the app realm did not quiesce within ${QUIESCE_BUDGET_MS}ms — ` +
          `${handle.pendingWorkTimers(WORK_HORIZON_MS)} timer(s) still due within ${WORK_HORIZON_MS}ms`,
      );
    }
  }
}