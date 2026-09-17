/**
 * The launch identity resolution shared by every site that opens or adopts an
 * agent session (§ agent presets).
 *
 * Before this module each site re-applied the same three layers by hand:
 * preset-aware manifest defaults (`resolveAgentDefaults`), the ticket's own
 * provider/model/effort, then a launch-time override (the Fix path's process
 * assignment). Keeping that chain in one pure, vscode-free place means a new
 * layer is added once, and the precedence can be pinned by unit tests rather
 * than by every call site.
 */

import type { AgentProvider, Manifest } from '../manifest/types.js';
import { resolveAgentDefaults } from './agentPresets.js';
import { resolveModelForProvider, resolveEffortForProvider } from './models.js';
import { bundledModelCatalog, type ModelCatalog } from './modelCatalog.js';

/** The per-ticket agent fields resolution reads. */
export interface LaunchTicket {
  agentPreset?: string | null;
  agentProvider?: AgentProvider | null;
  model?: string | null;
  effort?: string | null;
}

/**
 * An explicit per-launch override. When PRESENT it REPLACES the resolved
 * model/effort with its own fields (an absent field stays absent — the
 * override is not merged); `provider` still falls back when it is undefined.
 */
export interface LaunchOverride {
  provider?: AgentProvider;
  model?: string;
  effort?: string;
}

export interface LaunchIdentity {
  provider: AgentProvider;
  model?: string;
  effort?: string;
}

/** The launch identity for a ticket: preset-aware defaults, ticket overrides, then a launch override. */
export function resolveLaunchIdentity(
  manifest: Manifest,
  ticket: LaunchTicket,
  override?: LaunchOverride,
  catalog: ModelCatalog = bundledModelCatalog(),
): LaunchIdentity {
  const defaults = resolveAgentDefaults(manifest, {
    ticketPreset: ticket.agentPreset,
    explicitProvider: override?.provider ?? ticket.agentProvider ?? null,
  });
  const provider = defaults.provider;
  const model =
    override !== undefined
      ? override.model
      : resolveModelForProvider(provider, ticket.model, defaults.model, catalog);
  const effort =
    override !== undefined
      ? override.effort
      : resolveEffortForProvider(provider, ticket.effort, defaults.effort, model, catalog);
  return { provider, model, effort };
}

/** Just the provider a ticket resolves to (adapter selection, resume decisions). */
export function resolveTicketProvider(manifest: Manifest, ticket: LaunchTicket): AgentProvider {
  return resolveAgentDefaults(manifest, {
    ticketPreset: ticket.agentPreset,
    explicitProvider: ticket.agentProvider ?? null,
  }).provider;
}
