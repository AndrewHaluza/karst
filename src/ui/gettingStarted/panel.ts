import type { LogError } from '../../logging/logger.js';
import {
  parseGettingStartedMessage,
  routeGettingStartedAction,
  type GettingStartedActions,
  type GettingStartedHostMessage,
  type GettingStartedMessage,
} from './messages.js';
import type { GettingStartedState } from './state.js';
import type { GettingStartedActionsCtx, GettingStartedActionsFactory } from './actions.js';
import { readRequestId, reportAction } from '../../model/actionResult.js';

/** The subset of a `vscode.WebviewPanel` the Getting Started manager touches. */
export interface GettingStartedPanel {
  reveal(): void;
  postMessage(message: GettingStartedHostMessage): void;
  onDidReceiveMessage(handler: (message: unknown) => void): void;
  onDidDispose(handler: () => void): void;
}

/** Factory the manager uses to mint the panel (real: `createWebviewPanel`). */
export interface GettingStartedPanelHost {
  createPanel(title: string): GettingStartedPanel;
}

/**
 * Single Getting Started panel. `open` reveals an existing panel rather than spawning a
 * duplicate; disposal drops it so a later open recreates it. `loadState` is
 * called fresh on open and on every `pushState` (recheck / post-scaffold) so the
 * checklist always reflects live disk/PATH truth.
 */
export class GettingStartedManager {
  private panel: GettingStartedPanel | undefined;

  constructor(
    private readonly loadState: () => GettingStartedState,
    private readonly host: GettingStartedPanelHost,
    private readonly actionsFactory: GettingStartedActionsFactory,
    private readonly logError: LogError = (m, e) => console.error(m, e),
  ) {}

  open(): void {
    if (this.panel) {
      this.panel.reveal();
      return;
    }
    const panel = this.host.createPanel('Karst — Getting Started');
    this.panel = panel;

    const pushState = (): void => {
      panel.postMessage({ type: 'state', state: this.loadState() });
    };
    const ctx: GettingStartedActionsCtx = { pushState };
    const actions: GettingStartedActions = this.actionsFactory(ctx);

    panel.onDidReceiveMessage((raw) => {
      // The requestId is read off the RAW message, before parsing narrows it
      // away (parseGettingStartedMessage deliberately drops every field it does not
      // model). `reportAction` never rejects, so the message pump is safe by
      // construction; an unparsed message posts nothing (UI-R13).
      const requestId = readRequestId(raw);
      const msg = parseGettingStartedMessage(raw);
      if (!msg) return;
      void reportAction(requestId, (m) => panel.postMessage(m), () => this.runAction(msg, actions));
    });
    panel.onDidDispose(() => (this.panel = undefined));

    pushState();
  }

  isOpen(): boolean {
    return this.panel !== undefined;
  }

  /** Dispatch one parsed message, logging (but still surfacing) any failure. */
  private runAction(msg: GettingStartedMessage, actions: GettingStartedActions): void | Promise<void> {
    try {
      const result = routeGettingStartedAction(msg, actions);
      if (result && typeof (result as PromiseLike<void>).then === 'function') {
        return (result as Promise<void>).catch((err: unknown) => {
          this.logError('karst: getting-started action failed', err);
          throw err;
        });
      }
      return result;
    } catch (err) {
      this.logError('karst: getting-started action failed', err);
      throw err;
    }
  }
}
