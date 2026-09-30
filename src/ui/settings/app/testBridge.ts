/**
 * Test double for the settings app's host seam.
 *
 * The app never touches `window` for messaging — it goes through the injected
 * `SettingsHostBridge` (`hostBridge.ts`) — so a test can drive the whole app,
 * tab-scoped Save and fetch lifecycle included, against a bridge that records
 * outbound messages and can push any `SettingsHostMessage` back.
 *
 * A plain factory, not a hook: the bridge holds no React state, so a test can
 * build one before rendering and keep asserting on it after every commit.
 * `posted` and `persisted` are live (getters over the closure), so no test has
 * to re-fetch them or reason about a stale copy.
 */
import { createSender, type SettingsSender } from '../webviewSend.js';
import type { SettingsHostMessage, SettingsWebviewMessage } from '../messages.js';
import type { PersistedSettingsState, SettingsHostBridge } from './hostBridge.js';

/** One outbound message, including the async-action correlation id (UI-R13). */
export type Outbound = SettingsWebviewMessage & { requestId?: string };

export interface TestBridge extends SettingsHostBridge {
  /** Every message the app posted, oldest first. */
  readonly posted: readonly Outbound[];
  /** The most recent outbound message of `type`, or `undefined`. */
  last(type: SettingsWebviewMessage['type']): Outbound | undefined;
  /** Every outbound message of `type`, in order. */
  all(type: SettingsWebviewMessage['type']): readonly Outbound[];
  /** Push a host message at the app, as the extension host would. */
  push(message: SettingsHostMessage): void;
  /** What `getState()` reports. Assign to exercise the restore path. */
  persisted: PersistedSettingsState | undefined;
}

export function createTestBridge(initialState?: PersistedSettingsState): TestBridge {
  const posted: Outbound[] = [];
  const listeners: ((message: SettingsHostMessage) => void)[] = [];
  let persisted: PersistedSettingsState | undefined = initialState;

  const send: SettingsSender = createSender({
    postMessage: (message: unknown) => {
      posted.push(message as Outbound);
    },
  });

  return {
    send,
    get posted() {
      return posted;
    },
    last: (type) => [...posted].reverse().find((m) => m.type === type),
    all: (type) => posted.filter((m) => m.type === type),
    push: (message) => {
      for (const listener of [...listeners]) listener(message);
    },
    get persisted() {
      return persisted;
    },
    set persisted(value: PersistedSettingsState | undefined) {
      persisted = value;
    },
    getState: () => persisted,
    setState: (state) => {
      persisted = state;
    },
    subscribe: (listener) => {
      listeners.push(listener);
      return () => {
        const at = listeners.indexOf(listener);
        if (at >= 0) listeners.splice(at, 1);
      };
    },
  };
}
