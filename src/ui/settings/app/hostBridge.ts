/**
 * The settings app's single seam onto the webview page (NDL-126 §1, R-X7).
 *
 * `main.tsx` is the app bundle's only `acquireVsCodeApi()` caller (VS Code
 * throws on a second call) and publishes the page globals `vscode` and
 * `karstSend`. So the React app READS those globals instead of acquiring again,
 * and every outbound message still goes through the one typed sender whose
 * constructors are checked against `SettingsWebviewMessage` by `tsc`.
 *
 * The seam is an interface, not a module-level constant, so a component or a
 * COMPONENT test can drive the whole app against an injected double without a
 * webview. Nothing else in `app/` touches `window` for messaging.
 */
import { createSender, type SettingsSender, type WebviewApi } from '../webviewSend.js';
import type { SettingsHostMessage, SettingsWebviewMessage } from '../messages.js';

/** The persisted shape the settings webview keeps across a reload. */
export interface PersistedSettingsState {
  readonly manifest: unknown;
  readonly tokenConfigured: boolean;
}

/** Everything the app needs from the page, in one injected object. */
export interface SettingsHostBridge {
  /** The typed message constructors (`karstSend`). */
  readonly send: SettingsSender;
  /** Restore what the last session persisted, if anything. */
  getState(): PersistedSettingsState | undefined;
  /** Persist the session so a reload can restore it. */
  setState(state: PersistedSettingsState): void;
  /** Subscribe to host pushes; returns the unsubscribe function. */
  subscribe(listener: (message: SettingsHostMessage) => void): () => void;
}

/** `WebviewApi` plus the persisted-state pair `webviewSend.entry.ts` also exposes. */
export interface PageVsCodeApi extends WebviewApi {
  getState(): unknown;
  setState(state: unknown): void;
}

export interface PageGlobals {
  readonly vscode?: PageVsCodeApi;
  readonly karstSend?: SettingsSender;
  readonly mountAgentPicker?: AgentPickerMount;
  readonly __karstSubscribe?: (listener: (message: SettingsHostMessage) => void) => () => void;
}

/**
 * `mountAgentPicker(root, opts)` from the injected `KARST_AGENT_PICKER_JS` blob
 * (`src/model/agentPicker.ts`). Typed here, not reimplemented: the picker is a
 * shared vanilla runtime that mounts into an opaque container (R-X3).
 */
export type AgentPickerMount = (root: HTMLElement, opts: AgentPickerOptions) => void;

/** The one identity choice the picker represents: core + model + effort. */
export interface AgentPickerIdentity {
  readonly core: string;
  readonly model: string;
  readonly effort: string;
}

/** Exactly the option bag `agentPicker.webview.js` documents. */
export interface AgentPickerOptions {
  readonly cores: ReadonlyArray<{ readonly id: string; readonly label: string; readonly disabled?: boolean }>;
  readonly catalog: unknown;
  readonly recent: Readonly<Record<string, readonly string[]>>;
  readonly value: AgentPickerIdentity;
  readonly inherit: { readonly core?: string; readonly model?: string; readonly effort?: string };
  readonly inheritCore?: string;
  /**
   * Field captions the runtime renders beside each control. `agentPicker.webview.js`
   * reads them with its own fallbacks ("Agent core" / "Model" / "Effort /
   * variant"), so omitting them is legal but renders the generic wording; every
   * mount site in the vanilla view passes an explicit set, so the option is part
   * of the documented bag rather than an accident.
   */
  readonly labels?: {
    readonly core?: string;
    readonly model?: string;
    readonly effort?: string;
  };
  readonly disabled?: boolean;
  readonly showEffort?: boolean;
  readonly onChange: (value: AgentPickerIdentity) => void;
}

/**
 * The real bridge, over the page globals the sender bundle published.
 *
 * `send` is built from the SAME `createSender` the vanilla script uses rather
 * than re-declaring each constructor, so a renamed message field is a `tsc`
 * error on one definition, not two.
 */
export function pageHostBridge(scope: PageGlobals = globalThis as PageGlobals): SettingsHostBridge {
  const api = scope.vscode;
  if (!api) {
    throw new Error(
      'settings app: window.vscode is missing — main.tsx must run before any settings UI',
    );
  }
  const send = scope.karstSend ?? createSender(api);
  const target = scope as unknown as EventTarget;
  return {
    send,
    getState: () => (api.getState() as PersistedSettingsState | undefined) ?? undefined,
    setState: (state) => api.setState(state),
    subscribe: (listener) => {
      let unsub: () => void;
      if (scope.__karstSubscribe) {
        unsub = scope.__karstSubscribe(listener);
      } else if (typeof target?.addEventListener === 'function') {
        const onMessage = (event: Event): void => {
          const data = (event as MessageEvent).data as SettingsHostMessage | undefined;
          if (data && typeof data === 'object' && typeof data.type === 'string') listener(data);
        };
        target.addEventListener('message', onMessage);
        unsub = () => target.removeEventListener?.('message', onMessage);
      } else {
        unsub = () => {};
      }
      send.requestState();
      return unsub;
    },
  };
}

/** The injected shared picker runtime, or `null` when the blob is absent. */
export function pageAgentPicker(scope: PageGlobals = globalThis as PageGlobals): AgentPickerMount | null {
  return scope.mountAgentPicker ?? null;
}

/**
 * Post one message with no async lifecycle of its own. Reserved for the two
 * cases that are not mutations: the debounced tab-scoped `validate`, and the
 * single-fetch asks whose lifecycle is owned by the tab that triggers them.
 * Anything with a result goes through `useHostMutation` (R11–R15).
 */
export function postValidation(
  send: SettingsSender,
  message: Extract<SettingsWebviewMessage, { type: 'validate' }>,
): void {
  send.validate(message.manifest);
}
