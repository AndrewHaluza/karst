import type { Manifest } from '../../manifest/types.js';
import {
  routeSettingsAction,
  type SettingsActions,
  type SettingsHostMessage,
} from './messages.js';
import { buildSettingsState, type SettingsState } from './state.js';
import type { SettingsActionsFactory } from './actions.js';

/** The subset of a `vscode.WebviewPanel` the manager touches (host-agnostic). */
export interface SettingsPanel {
  reveal(): void;
  postMessage(message: SettingsHostMessage): void;
  onDidReceiveMessage(handler: (message: unknown) => void): void;
  onDidDispose(handler: () => void): void;
}

/** Factory the manager uses to mint a panel (real: `createWebviewPanel`). */
export interface SettingsPanelHost {
  createPanel(title: string): SettingsPanel;
}

/**
 * The manifest to edit + a validation error. A clean load has `error:null`; a
 * broken file supplies a best-effort raw manifest plus the error so the page
 * still opens (fixing a broken manifest is the point of the settings UI).
 */
export interface LoadedManifest {
  manifest: Manifest;
  error: string | null;
}

/**
 * Single settings panel. `open` reveals an existing panel rather than spawning a
 * duplicate; disposal drops it so a later open recreates it. State (manifest +
 * error) is pushed on open; incoming messages route to injected host actions.
 */
export class SettingsManager {
  private panel: SettingsPanel | undefined;

  constructor(
    private readonly loadState: () => LoadedManifest,
    private readonly manifestPath: () => string,
    private readonly host: SettingsPanelHost,
    private readonly actionsFactory: SettingsActionsFactory,
    private readonly listInstalledIds: () => string[] = () => [],
    private readonly hasToken: () => Promise<boolean> = async () => false,
    private readonly listAgentRows: () => SettingsState['agents'] = () => [],
    private readonly listApproachCommands: () => Record<string, string[]> = () => ({}),
  ) {}

  async open(): Promise<void> {
    if (this.panel) {
      this.panel.reveal();
      return;
    }
    const panel = this.host.createPanel('Karst Settings');
    this.panel = panel;

    const actions: SettingsActions = this.actionsFactory({
      post: (message) => panel.postMessage(message),
      manifestPath: this.manifestPath(),
    });

    panel.onDidReceiveMessage((raw) => {
      try {
        routeSettingsAction(raw, actions);
      } catch (err) {
        // The message pump must never die on one bad message.
        console.error('karst: settings action failed', err);
      }
    });
    panel.onDidDispose(() => (this.panel = undefined));

    const { manifest, error } = this.loadState();
    const tokenConfigured = await this.hasToken();
    panel.postMessage({
      type: 'state',
      state: buildSettingsState(
        manifest,
        error,
        this.listInstalledIds(),
        tokenConfigured,
        undefined,
        this.listAgentRows(),
        this.listApproachCommands(),
      ),
    });
  }

  isOpen(): boolean {
    return this.panel !== undefined;
  }
}
