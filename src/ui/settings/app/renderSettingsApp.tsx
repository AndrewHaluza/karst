/**
 * A rendered-Settings test through `renderWebviewReady`, with the React app
 * mounted (NDL-126 §9.5).
 *
 * `renderWebviewReady` alone returns the VANILLA render today: `injectSettingsApp`
 * is a no-op until phase 4 places the `/*KARST_SETTINGS_APP*\/` marker, so the
 * shipped document has no `#root` and the harness hands back the inline script's
 * output. That is correct for phase 3 — the vanilla view must stay the live one —
 * but it means "assert the tab renders" has to mount the app itself.
 *
 * So this helper goes through `renderWebviewReady` for the DOCUMENT (real
 * `webview.html`, real hydrated injector chain, real CSP nonce, real shared
 * stylesheet, real `acquireVsCodeApi` double), then mounts `<App/>` into a
 * `#root` it adds, and lets the app set the same `data-karst-ready` flag the
 * harness waits on. Phase 4 removes this helper, not the assertions: once the
 * chain injects the app, `renderWebviewReady('settings')` does this on its own.
 *
 * It lives under `src/ui/settings/app/` because that is the only directory
 * allowed to import React (R01), and beside `App.tsx` so the two cannot drift.
 */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderWebviewReady, type RenderHandle } from '../../testing/renderHarness.js';
import type { SettingsHostMessage, SettingsWebviewMessage } from '../messages.js';
import { createSender, type SettingsSender } from '../webviewSend.js';
import { App, type AppProps } from './App.js';
import { AppSections } from './sections/AppSections.js';
import { AppProbe } from './sections/AppProbe.js';
import type { SettingsHostBridge } from './hostBridge.js';

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
  /** The most recent outbound message of `type`, or `undefined`. */
  last(type: SettingsWebviewMessage['type']): Outbound | undefined;
  /** What the app persisted through the page's `setState`. */
  readonly state: unknown;
}

/**
 * A recording bridge, wrapping whatever the caller injected.
 *
 * The app subscribes through THIS helper and delivers through it too, so a
 * `receive()` reaches the app exactly once no matter what the caller injected.
 * An injected bridge still owns the outbound side (`send`), the persisted state
 * (`getState`/`setState`) and `posted`; only the inbound fan-in is owned here,
 * which is what keeps "the host pushed one message" from becoming "the app
 * reduced it twice".
 */
function makeBridge(injected: SettingsHostBridge | undefined) {
  const posted: Outbound[] = [];
  const listeners: ((message: SettingsHostMessage) => void)[] = [];
  let persisted: unknown;
  const send: SettingsSender =
    injected?.send ??
    createSender({
      postMessage: (message: unknown) => {
        posted.push(message as Outbound);
      },
    });
  return {
    bridge: {
      send,
      getState: () => injected?.getState() ?? persisted,
      setState: (state: never) => {
        if (injected) injected.setState(state);
        else persisted = state;
      },
      subscribe: (listener: (message: SettingsHostMessage) => void) => {
        listeners.push(listener);
        return () => {
          const at = listeners.indexOf(listener);
          if (at >= 0) listeners.splice(at, 1);
        };
      },
    } as SettingsHostBridge,
    posted,
    push: (message: SettingsHostMessage) => {
      for (const listener of [...listeners]) listener(message);
    },
    deliver: (message: SettingsHostMessage) => {
      for (const listener of [...listeners]) listener(message);
    },
    state: () => injected?.getState() ?? persisted,
  };
}

export interface RenderSettingsOptions extends AppProps {
  /**
   * Mount the derived-state probe alongside the tab. On by default: every
   * rendered-Settings assertion about dirty markers, banners or the draft reads
   * the reducer's own output through it.
   */
  readonly withProbe?: boolean;
}

export async function renderSettingsApp(options: RenderSettingsOptions = {}): Promise<RenderedSettings> {
  const { withProbe = true, ...props } = options;
  // React only treats `act` as an environment check when the realm that loaded
  // react-dom says so. Without it every `act()` here is a no-op and an
  // unwrapped activation would hide the pending state UI-R11 is about.
  const actEnv = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const previousActEnv = actEnv.IS_REACT_ACT_ENVIRONMENT;
  actEnv.IS_REACT_ACT_ENVIRONMENT = true;
  const handle = await renderWebviewReady('settings');
  const mountRoot = handle.document.createElement('div');
  mountRoot.id = 'root';
  // The vanilla sections stay in the document: the React view is mounted ALONGSIDE
  // them until phase 4, exactly as it will be in the shipped pre-marker build.
  const mountPoint = handle.query('.content') ?? handle.document.body;
  mountPoint.appendChild(mountRoot);

  const recorder = makeBridge(props.bridge);

  await act(async () => {
    createRoot(mountRoot).render(
      <App {...props} bridge={recorder.bridge}>
        {withProbe ? (
          <>
            <AppSections />
            <AppProbe />
          </>
        ) : (
          <AppSections />
        )}
      </App>,
    );
    await Promise.resolve();
  });

  const settle = async (): Promise<void> => {
    await act(async () => {
      await Promise.resolve();
    });
  };

  return {
    window: handle.window,
    document: handle.document,
    errors: handle.errors,
    get posted() {
      return recorder.posted;
    },
    get state() {
      return recorder.state();
    },
    last: (type) => [...recorder.posted].reverse().find((m) => m.type === type),
    async receive(message: SettingsHostMessage) {
      await act(async () => {
        recorder.deliver(message);
        await Promise.resolve();
      });
    },
    settle,
    async click(target: Element | string) {
      const node = typeof target === 'string' ? inRoot(handle, target) : target;
      await act(async () => {
        node.dispatchEvent(
          new (handle.window.MouseEvent)('click', { bubbles: true, cancelable: true }),
        );
        await Promise.resolve();
      });
    },
    async focus(target: Element) {
      await act(async () => {
        target.dispatchEvent(new (handle.window.FocusEvent)('focus'));
        await Promise.resolve();
      });
    },
    query: handle.query,
    queryAll: handle.queryAll,
    cssRules: handle.cssRules,
    close: () => {
      handle.close();
      actEnv.IS_REACT_ACT_ENVIRONMENT = previousActEnv;
    },
  };
}

/**
 * Resolve a selector inside the React tree, or throw with it.
 *
 * Through the harness handle's own `query` rather than a bare document lookup:
 * `document.querySelector` is banned across the app by R09b, and reaching around
 * the harness here would put it back. An attribute selector, not `#root`, because
 * the vanilla sections share this document until phase 4 and two elements
 * answer to `#section-general`.
 */
function inRoot(handle: RenderHandle, selector: string): Element {
  const node = handle.query('[id="root"]')?.querySelector(selector);
  if (!node) throw new Error(`no element matches "${selector}" inside the React tree`);
  return node;
}
