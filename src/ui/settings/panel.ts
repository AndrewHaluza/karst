import type { Manifest } from '../../manifest/types.js';
import {
  parseSettingsMessage,
  routeSettingsAction,
  type SettingsActions,
  type SettingsHostMessage,
} from './messages.js';
import { buildSettingsState, type SettingsState } from './state.js';
import type { SettingsActionsFactory } from './actions.js';
import type { LogError } from '../../logging/logger.js';
import {
  bundledModelCatalog,
  type ModelCatalog,
} from '../../agent/modelCatalog.js';
import { compatibilityModelCatalog } from '../../agent/models.js';
import { readRequestId, reportAction } from '../../model/actionResult.js';

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
    /** Report a caught pump error to the Karst output channel. */
    private readonly logError: LogError = (m, e) => console.error(m, e),
    /** Current launch-model catalog, refreshed independently of the manifest. */
    private readonly modelCatalog: () => ModelCatalog = bundledModelCatalog,
    /** The project identity this window resolved (§ state.ts `projectSlug`). */
    private readonly projectSlug: () => SettingsState['projectSlug'] = () => ({
      value: '',
      derived: true,
    }),
    /** Extension version from package.json (§ state.ts `version`). */
    private readonly version: () => string = () => '',
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
      projectSlug: this.projectSlug(),
      version: this.version(),
    });

    panel.onDidReceiveMessage((raw) => {
      // Read the correlation id off the RAW message, before it is narrowed —
      // `parseSettingsMessage` deliberately drops fields it does not model, and
      // that dropping is the trust boundary (see readRequestId's own doc).
      const requestId = readRequestId(raw);
      // An unparsed message posts NOTHING (UI-R13): no action ran, so there is
      // no terminal outcome to report, and reporting one anyway would ack a
      // message the host never acted on.
      if (!parseSettingsMessage(raw)) return;
      void reportAction(requestId, (message) => panel.postMessage(message), () => {
        // The message pump must never die on one bad message — log it either
        // way, then rethrow so reportAction reports the real failure as
        // `ok:false` rather than a silent ack. Kept synchronous when the
        // matched action is synchronous, so an immediate ack stays immediate.
        try {
          const result = routeSettingsAction(raw, actions);
          if (result && typeof (result as PromiseLike<void>).then === 'function') {
            return (result as Promise<void>).catch((err: unknown) => {
              this.logError('karst: settings action failed', err);
              throw err;
            });
          }
          return result;
        } catch (err) {
          this.logError('karst: settings action failed', err);
          throw err;
        }
      });
    });
    panel.onDidDispose(() => (this.panel = undefined));

    await this.pushState(panel);
  }

  /** Push the current catalog to the settings panel when it is still live. */
  async refreshModels(): Promise<void> {
    const panel = this.panel;
    if (!panel) return;
    const models = this.modelCatalog();
    panel.postMessage({
      type: 'models',
      models,
      modelCompatibility: compatibilityModelCatalog(models),
    });
  }

  private async pushState(panel: SettingsPanel): Promise<void> {
    const { manifest, error } = this.loadState();
    const tokenConfigured = await this.hasToken();
    if (this.panel !== panel) return;
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
        this.modelCatalog(),
        this.manifestPath(),
        this.projectSlug(),
        this.version(),
      ),
    });
  }

  isOpen(): boolean {
    return this.panel !== undefined;
  }
}
