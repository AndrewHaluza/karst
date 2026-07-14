import type { LogError } from '../../logging/logger.js';
import { routeWelcomeAction, type WelcomeActions, type WelcomeHostMessage } from './messages.js';
import type { WelcomeState } from './state.js';
import type { WelcomeActionsCtx, WelcomeActionsFactory } from './actions.js';

/** The subset of a `vscode.WebviewPanel` the welcome manager touches. */
export interface WelcomePanel {
  reveal(): void;
  postMessage(message: WelcomeHostMessage): void;
  onDidReceiveMessage(handler: (message: unknown) => void): void;
  onDidDispose(handler: () => void): void;
}

/** Factory the manager uses to mint the panel (real: `createWebviewPanel`). */
export interface WelcomePanelHost {
  createPanel(title: string): WelcomePanel;
}

/**
 * Single welcome panel. `open` reveals an existing panel rather than spawning a
 * duplicate; disposal drops it so a later open recreates it. `loadState` is
 * called fresh on open and on every `pushState` (recheck / post-scaffold) so the
 * checklist always reflects live disk/PATH truth.
 */
export class WelcomeManager {
  private panel: WelcomePanel | undefined;

  constructor(
    private readonly loadState: () => WelcomeState,
    private readonly host: WelcomePanelHost,
    private readonly actionsFactory: WelcomeActionsFactory,
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
    const ctx: WelcomeActionsCtx = {
      post: (message) => panel.postMessage(message),
      pushState,
    };
    const actions: WelcomeActions = this.actionsFactory(ctx);

    panel.onDidReceiveMessage((raw) => {
      try {
        routeWelcomeAction(raw, actions);
      } catch (err) {
        // The message pump must never die on one bad message.
        this.logError('karst: welcome action failed', err);
      }
    });
    panel.onDidDispose(() => (this.panel = undefined));

    pushState();
  }

  isOpen(): boolean {
    return this.panel !== undefined;
  }
}
