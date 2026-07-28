import type { ApproachDef, Manifest } from '../../manifest/types.js';
import { validateManifest, ManifestError } from '../../manifest/schema.js';
import { installCommandFor } from '../../approaches/fetch.js';
import type { SettingsActions, SettingsHostMessage } from './messages.js';
import { buildSettingsState, type SettingsState } from './state.js';
import type { LoadedManifest } from './panel.js';
import type { TicketingProvider } from '../../integrations/ticketing.js';
import type { TicketingConfig } from '../../manifest/types.js';

/** Per-panel context: how to post to this webview + which file it edits. */
export interface SettingsActionsCtx {
  post(message: SettingsHostMessage): void;
  manifestPath: string;
}

/** Injected host dependencies (real ones bound in extension.ts). */
export interface SettingsActionsDeps {
  writeManifest(path: string, manifest: Manifest): void;
  /** Re-read the manifest from disk into the host's live copy. */
  reloadManifest(): void;
  /** Refresh sidebar + open dashboard/onboarding after a save. */
  onChange(): void;
  /**
   * Re-read the manifest FILE for a state push — the same source `open` uses,
   * so `request-state` (the webview's recovery for the dropped initial push)
   * and the post-save push carry the file's typed values AND any validation
   * error, not a possibly-empty in-memory copy.
   */
  loadState(): LoadedManifest;
  /** Install a resolved approach package (real installer bound in extension.ts). */
  installApproach(def: ApproachDef): Promise<unknown>;
  /**
   * Confirm (host-side, modal) that `command` may run before an npm-source
   * install shells it out. Resolves true to proceed, false if the user declined.
   *
   * The command string comes from the workspace's `karst.yml` and runs through a
   * shell, so a cloned or shared repo would otherwise execute arbitrary shell on
   * install with nothing prompting the user. This is the gate; the caller shows
   * the command verbatim so the user can see what they are agreeing to.
   */
  confirmInstallCommand(command: string): Promise<boolean>;
  /** Remove an installed approach package by id. */
  uninstallApproach(id: string): boolean;
  /** Ids of approach packages currently present on disk. */
  listInstalledIds(): string[];
  /**
   * Prompt (host-side) for and store the ClickUp token; resolves true if a token
   * was set, false if the user cancelled. The raw token never crosses back here.
   */
  setToken(): Promise<boolean>;
  /** Clear the stored ClickUp token. */
  clearToken(): Promise<void>;
  /** Whether a ClickUp token is currently stored (drives the state flag). */
  hasToken(): Promise<boolean>;
  /** Write an agent file's full body under agentsDir (create or overwrite). */
  saveAgentFile(name: string, body: string): void;
  /** Create a new agent file from a starter template. */
  createAgent(name: string): void;
  /** Remove an agent file under agentsDir. */
  deleteAgent(name: string): void;
  /** Full selectable agent pool as rows for the Agents tab (state.ts stays fs-free). */
  listAgentRows(): SettingsState['agents'];
  /** Command names each installed approach exposes, for the Commands tab. */
  listApproachCommands(): Record<string, string[]>;
  /** Read a command's markdown body: a native `commands/<name>.md` file, or the
   *  generated `/karst:<id>` orchestrator rendered from the package's workflow. */
  readApproachCommandBody(approachId: string, command: string): string;
  /**
   * Build a ticketing provider for an ad-hoc config (the settings DRAFT), so the
   * status list can be fetched before the config is saved. Injected to keep this
   * module free of `fetch` and of `vscode`.
   */
  makeProvider(config: TicketingConfig): TicketingProvider;
  /**
   * Open a native folder picker (host-side) for a repository's repoPath.
   * Resolves the chosen absolute path, or undefined if the user cancelled.
   */
  browseForFolder(): Promise<string | undefined>;
}

export type SettingsActionsFactory = (ctx: SettingsActionsCtx) => SettingsActions;

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function buildSettingsActions(deps: SettingsActionsDeps): SettingsActionsFactory {
  return (ctx: SettingsActionsCtx): SettingsActions => {
    /**
     * Re-read the manifest file and push state carrying fresh installedIds +
     * token-configured flag. Async because the token flag is read from
     * SecretStorage via `deps.hasToken`.
     */
    async function pushStateWithInstalled(): Promise<void> {
      const loaded = deps.loadState();
      const tokenConfigured = await deps.hasToken();
      ctx.post({
        type: 'state',
        state: buildSettingsState(
          loaded.manifest,
          loaded.error,
          deps.listInstalledIds(),
          tokenConfigured,
          undefined,
          deps.listAgentRows(),
          deps.listApproachCommands(),
        ),
      });
    }

    return {
      validate(manifest: Manifest): void {
        try {
          validateManifest(manifest);
          ctx.post({ type: 'validation', ok: true, error: null });
        } catch (e) {
          if (!(e instanceof ManifestError)) throw e;
          ctx.post({ type: 'validation', ok: false, error: errorMessage(e) });
        }
      },

      async save(manifest: Manifest): Promise<void> {
        try {
          validateManifest(manifest); // guard before touching disk
        } catch (e) {
          if (!(e instanceof ManifestError)) throw e;
          ctx.post({ type: 'error', message: errorMessage(e) });
          return;
        }
        try {
          deps.writeManifest(ctx.manifestPath, manifest);
          deps.reloadManifest(); // refresh host's live copy BEFORE state push
          deps.onChange();
          await pushStateWithInstalled();
          ctx.post({ type: 'saved' });
        } catch (e) {
          ctx.post({ type: 'error', message: errorMessage(e) });
        }
      },

      async installApproach(id: string): Promise<void> {
        const loaded = deps.loadState();
        const def = loaded.manifest.approaches?.find((a) => a.id === id);
        if (!def) {
          ctx.post({ type: 'error', message: `Unknown approach "${id}".` });
          return;
        }
        // An npm source shells out `source.command`; everything else only reads
        // files. Gate the shell-out on an explicit confirm — a decline is a
        // choice, not a failure, so it returns quietly rather than posting an
        // error.
        const command = installCommandFor(def);
        if (command !== null && !(await deps.confirmInstallCommand(command))) return;

        try {
          await deps.installApproach(def);
          await pushStateWithInstalled();
        } catch (e) {
          ctx.post({ type: 'error', message: errorMessage(e) });
        }
      },

      async uninstallApproach(id: string): Promise<void> {
        try {
          deps.uninstallApproach(id);
          await pushStateWithInstalled();
        } catch (e) {
          ctx.post({ type: 'error', message: errorMessage(e) });
        }
      },

      async setToken(): Promise<void> {
        try {
          await deps.setToken();
          await pushStateWithInstalled();
        } catch (e) {
          ctx.post({ type: 'error', message: errorMessage(e) });
        }
      },

      async clearToken(): Promise<void> {
        try {
          await deps.clearToken();
          await pushStateWithInstalled();
        } catch (e) {
          ctx.post({ type: 'error', message: errorMessage(e) });
        }
      },

      /**
       * The typed-path field's second input method. The picked path is just text
       * in the field, exactly as if it had been typed — `validateManifest` stays
       * the only authority on whether it is acceptable.
       */
      async browseRepoPath(name: string): Promise<void> {
        try {
          const path = await deps.browseForFolder();
          if (path === undefined) return; // cancelled — leave the field as-is
          ctx.post({ type: 'repo-path-picked', name, path });
        } catch (e) {
          ctx.post({ type: 'error', message: errorMessage(e) });
        }
      },

      async setApproachEnabled(id: string, enabled: boolean): Promise<void> {
        const loaded = deps.loadState();
        const approach = (loaded.manifest.approaches ?? []).find((a) => a.id === id);
        if (!approach) {
          ctx.post({ type: 'error', message: `Unknown approach "${id}".` });
          return;
        }
        // Guard: a SOURCED approach can only be ENABLED once its package is
        // installed. Built-in (sourceless) approaches have nothing to install, so
        // they are always enable-able. Disabling is always allowed (lets a user
        // turn off an approach that was uninstalled out from under an
        // `enabled: true` flag). Never trust the webview alone.
        if (enabled && approach.source && !deps.listInstalledIds().includes(id)) {
          ctx.post({ type: 'error', message: `Install "${id}" before enabling it.` });
          return;
        }
        try {
          const next: Manifest = {
            ...loaded.manifest,
            approaches: (loaded.manifest.approaches ?? []).map((a) =>
              a.id === id ? { ...a, enabled } : a,
            ),
          };
          deps.writeManifest(ctx.manifestPath, next);
          deps.reloadManifest();
          deps.onChange();
          await pushStateWithInstalled();
        } catch (e) {
          ctx.post({ type: 'error', message: errorMessage(e) });
        }
      },

      async setAgentEnabled(name: string, enabled: boolean): Promise<void> {
        try {
          const loaded = deps.loadState();
          const next: Manifest = {
            ...loaded.manifest,
            agents: {
              ...(loaded.manifest.agents ?? {}),
              [name]: { ...(loaded.manifest.agents?.[name] ?? { role: name }), enabled },
            },
          };
          deps.writeManifest(ctx.manifestPath, next);
          deps.reloadManifest();
          deps.onChange();
          await pushStateWithInstalled();
        } catch (e) {
          ctx.post({ type: 'error', message: errorMessage(e) });
        }
      },

      async saveAgentFile(name: string, body: string): Promise<void> {
        try {
          deps.saveAgentFile(name, body);
          await pushStateWithInstalled();
        } catch (e) {
          ctx.post({ type: 'error', message: errorMessage(e) });
        }
      },

      async createAgent(name: string): Promise<void> {
        try {
          deps.createAgent(name);
          await pushStateWithInstalled();
        } catch (e) {
          ctx.post({ type: 'error', message: errorMessage(e) });
        }
      },

      async deleteAgent(name: string): Promise<void> {
        try {
          deps.deleteAgent(name);
          await pushStateWithInstalled();
        } catch (e) {
          ctx.post({ type: 'error', message: errorMessage(e) });
        }
      },

      async requestState(): Promise<void> {
        await pushStateWithInstalled();
      },

      async getApproachCommandBody(approachId: string, command: string): Promise<void> {
        try {
          const body = deps.readApproachCommandBody(approachId, command);
          ctx.post({ type: 'approach-command-body', approachId, command, body });
        } catch (e) {
          ctx.post({ type: 'error', message: errorMessage(e) });
        }
      },

      async fetchTicketStatuses(listId: string, teamId?: string): Promise<void> {
        const provider = deps.makeProvider({
          provider: 'clickup',
          listId,
          ...(teamId ? { teamId } : {}),
        });
        if (!provider.listStatuses) {
          ctx.post({
            type: 'ticket-statuses-error',
            message: 'This provider cannot list statuses.',
          });
          return;
        }
        try {
          ctx.post({ type: 'ticket-statuses', statuses: await provider.listStatuses() });
        } catch (e) {
          // Status-scoped, not panel-level: this lands on the hint line beside the
          // control that caused it.
          ctx.post({ type: 'ticket-statuses-error', message: errorMessage(e) });
        }
      },

      async fetchTicketLists(teamId: string): Promise<void> {
        const provider = deps.makeProvider({ provider: 'clickup', teamId });
        if (!provider.listLists) {
          ctx.post({ type: 'ticket-lists-error', message: 'This provider cannot list lists.' });
          return;
        }
        try {
          ctx.post({ type: 'ticket-lists', lists: await provider.listLists() });
        } catch (e) {
          ctx.post({ type: 'ticket-lists-error', message: errorMessage(e) });
        }
      },
    };
  };
}
