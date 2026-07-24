import type { AgentProvider, Manifest } from '../../manifest/types.js';
import { sortAgentRowsByProvenance } from './agentGrouping.js';

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
}

/** Build the initial settings state from a manifest (valid or last-known). */
export function buildSettingsState(
  manifest: Manifest,
  error: string | null = null,
  installedIds: string[] = [],
  tokenConfigured = false,
  implementedProviders: AgentProvider[] = ['claude', 'codex', 'antigravity'],
  agents: SettingsAgentRow[] = [],
  approachCommands: Record<string, string[]> = {},
): SettingsState {
  return {
    manifest,
    error,
    installedIds,
    tokenConfigured,
    implementedProviders,
    agents: sortAgentRowsByProvenance(agents),
    approachCommands,
  };
}
