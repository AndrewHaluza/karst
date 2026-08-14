import type { AgentProvider, ApproachDef, Manifest } from '../../manifest/types.js';
import { sortAgentRowsByProvenance } from './agentGrouping.js';
import {
  bundledModelCatalog,
  type ModelCatalog,
} from '../../agent/modelCatalog.js';
import { compatibilityModelCatalog } from '../../agent/models.js';
import {
  buildProcessAssignmentViews,
  type SettingsProcessAssignmentView,
} from './processAssignmentViews.js';

/**
 * A row for the Agents tab: one selectable single-subagent (local file or
 * approach artifact), whether it's enabled (manifest `agents[name].enabled`,
 * default true), and its editable body — the file contents for a local file,
 * `null` for an approach artifact (those aren't edited here, only installed).
 */
export interface SettingsAgentRow {
  name: string;
  source: 'file' | 'approach';
  approachId?: string;
  enabled: boolean;
  body: string | null;
}

/**
 * Fully serializable settings state pushed to the webview. `manifest` is the
 * editable draft source; `error` is the current validation message (null when
 * the draft is valid) so the webview can disable Save + show the message;
 * `installedIds` is the list of approach package ids present on disk;
 * `tokenConfigured` is whether a ClickUp API token is stored (never the token
 * itself — the secret never crosses the webview boundary); `implementedProviders`
 * gates which `agentProvider` options the provider select renders enabled (the
 * rest show as disabled "coming soon" — see `agent/registry.ts`); `agents` is
 * the full selectable agent pool (unfiltered by enable state, so a disabled
 * agent can still be re-enabled from the Agents tab); `approachCommands` maps
 * each INSTALLED approach id to the command names it exposes (a `karst-<id>`
 * command when it has a workflow, plus any `command`-kind artifact basenames).
 * `models` is the host's current model catalog for all agent providers.
 *
 * `state.ts` stays pure/host-agnostic (no fs) — `agents` and `approachCommands`
 * are computed by the host (extension.ts) and injected here, mirroring how
 * `installedIds` is injected.
 */
export interface SettingsState {
  manifest: Manifest;
  error: string | null;
  installedIds: string[];
  tokenConfigured: boolean;
  implementedProviders: AgentProvider[];
  agents: SettingsAgentRow[];
  approachCommands: Record<string, string[]>;
  models: ModelCatalog;
  modelCompatibility: ModelCatalog;
  /**
   * The models most recently used per provider, newest first, capped at 5 —
   * the shared agent picker's "Last used" group (model/agentPicker.ts `recent`).
   * Read from the append-only `token_usage` ledger by the host, so the group
   * appears identically in Settings, the dashboard switch and the ticket form.
   */
  recentModels: Record<string, string[]>;
  /**
   * Per-row views for the Agents tab's inside-process assignments (handoff
   * §7): role labels, descriptions, the four validation states and their
   * inline messages, the Default hints. Computed host-side from the manifest,
   * the agent pool and the model catalogs — the webview renders these
   * verbatim and derives nothing.
   */
  processAssignments: SettingsProcessAssignmentView[];
  /** Absolute path of the manifest this window reads. Displayed, never edited. */
  manifestPath: string;
  /**
   * The packaged built-in approach definitions, host-computed at push time.
   * The webview mirrors the Settings-write delta rule against these (UI-R34):
   * Save serializes only the delta vs the packaged definition, never the
   * merged effective object, and the webview cannot import the host's TS.
   */
  packagedApproaches: ApproachDef[];
  /**
   * The project identity tickets are scoped by. `derived: true` means the
   * manifest declares no `id:` and the host fell back to a path-derived slug —
   * which changes if the repo moves, so it is the case worth showing.
   */
  projectSlug: { value: string; derived: boolean };
  /** Extension version from package.json — displayed, never edited. */
  version: string;
}

/** Build the initial settings state from a manifest (valid or last-known). */
export function buildSettingsState(
  manifest: Manifest,
  error: string | null = null,
  installedIds: string[] = [],
  tokenConfigured = false,
  implementedProviders: AgentProvider[] = ['claude', 'codex', 'antigravity', 'opencode'],
  agents: SettingsAgentRow[] = [],
  approachCommands: Record<string, string[]> = {},
  models: ModelCatalog = bundledModelCatalog(),
  manifestPath = '',
  projectSlug: { value: string; derived: boolean } = { value: '', derived: true },
  version = '',
  packagedApproaches: ApproachDef[] = [],
  recentModels: Record<string, string[]> = {},
): SettingsState {
  return {
    manifest,
    error,
    installedIds,
    tokenConfigured,
    implementedProviders,
    agents: sortAgentRowsByProvenance(agents),
    approachCommands,
    models,
    modelCompatibility: compatibilityModelCatalog(models),
    recentModels,
    processAssignments: buildProcessAssignmentViews(
      manifest,
      agents.map((a) => a.name),
      models,
    ),
    manifestPath,
    projectSlug,
    version,
    packagedApproaches,
  };
}
