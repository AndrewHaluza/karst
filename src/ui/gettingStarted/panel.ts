import type { RestoredPanel } from '../shared/restoredPanel.js';
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
    private readonly loadState: (options: { recheck: boolean }) => GettingStartedState | Promise<GettingStartedState>,
    private readonly host: GettingStartedPanelHost,
    private readonly actionsFactory: GettingStartedActionsFactory,
    private readonly logError: LogError = (m, e) => console.error(m, e),
  ) {}

  open(): void {
    if (this.panel) {
      this.panel.reveal();
      return;
    }
    this.start(this.host.createPanel('Karst — Getting Started'));
  }

  /** Adopt the tab VS Code restored after a reload; a duplicate is closed. Never reveals. */
  adopt(restored: RestoredPanel<GettingStartedPanel>): boolean {
    if (this.panel) {
      restored.dispose();
      return false;
    }
    this.start(restored.wrap());
    return true;
  }

  private start(panel: GettingStartedPanel): void {
    this.panel = panel;

    let latest = 0;
    const pushState = (recheck: boolean): void => {
      const seq = ++latest;
      // The probe behind the state is async, so a slow tool never blocks the host.
      // An older, slower load must not overwrite a newer one.
      const post = (state: GettingStartedState): void => {
        if (seq === latest) panel.postMessage({ type: 'state', state });
      };
      try {
        const loaded = this.loadState({ recheck });
        if (loaded instanceof Promise) {
          loaded.then(post).catch((e: unknown) => this.logError('karst: getting started state failed', e));
        } else {
          post(loaded);
        }
      } catch (e) {
        this.logError('karst: getting started state failed', e);
      }
    };
    const ctx: GettingStartedActionsCtx = { pushState: () => pushState(true) };
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

    pushState(false);
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
