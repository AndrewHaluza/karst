import type { AgentProvider } from '../../manifest/types.js';
import { resolveProvider } from '../../agent/registry.js';
import { IMPLEMENTED_PROVIDERS } from '../../agent/provider.js';
import { resolveEffortForProvider } from '../../agent/models.js';
import {
  buildAgentSessionView,
  agentSwitchCoreChoices,
  agentSwitchModelChoices,
} from '../../agent/sessionSwitch.js';
import { bundledModelCatalog } from '../../agent/modelCatalog.js';
import type { DashboardAgentContext, DashboardState } from './stateTypes.js';

/**
 * The ticket facts the resolved agent identity reads. A narrowed shape, not the
 * whole ticket row: the state builder owns the store read, this module never
 * touches the store.
 */
export interface AgentStateInput {
  ticket: {
    agentPreset: string | null;
    agentProvider: AgentProvider | null;
    model: string | null;
    effort: string | null;
    stageCurrent: string | null;
  };
  /** True while a recovery round is actively fixing — the session must say so. */
  fixExecutionActive: boolean;
  /** Manifest-level agent core; omitted → a captured session degrades to "Start". */
  defaultProvider?: AgentProvider;
  /** Live session/model context, injected by the extension host. */
  agentContext: DashboardAgentContext;
  /** Models most recently used per provider (newest first, ≤5), host-read. */
  recentByCore: Record<string, string[]>;
}

/** The resolved session identity and the header switch popover's choices. */
export interface AgentStateView {
  agentSession: DashboardState['agentSession'];
  agentSwitch: DashboardState['agentSwitch'];
}

/**
 * Resolve the ticket's agent identity and the header's agent-switch choices.
 *
 * The defaults are the EFFECTIVE identity the host already resolved for this
 * ticket (§7.6: ticket override → active preset slot → manifest default), so
 * the header states what launch would open rather than the bare manifest
 * fields a preset overrides. A preset is a (core, model) pair: its model is
 * the default only for that identity's own core, so switching to another core
 * inherits nothing from the preset and cannot prefill its model.
 */
export function buildAgentState(input: AgentStateInput): AgentStateView {
  const { ticket, fixExecutionActive, defaultProvider, agentContext, recentByCore } = input;
  // The DEFAULTS are what LAUNCH resolves for this ticket (§7.6), so the
  // header states the preset's identity instead of the bare manifest fields a
  // preset overrides. The identity arrives as plain data from the host — the
  // same object the capability labels render — never a resolver function.
  const impl = agentContext.capabilityIdentity?.implementation ?? null;
  const defaults = impl
    ? { provider: impl.provider, model: impl.model ?? undefined, effort: impl.effort ?? undefined }
    : {
        provider: ticket.agentProvider ?? defaultProvider ?? 'claude',
        model: agentContext.defaultModel ?? undefined,
        effort: agentContext.defaultEffort ?? undefined,
      };
  const resolvedProvider = resolveProvider(ticket.agentProvider, defaults.provider);
  const agentSession = buildAgentSessionView({
    provider: resolvedProvider,
    ticketModel: ticket.model,
    defaultModel: defaults.model ?? null,
    ticketEffort: ticket.effort,
    defaultEffort: defaults.effort ?? null,
    catalog: agentContext.modelCatalog ?? bundledModelCatalog(),
    stageCurrent: ticket.stageCurrent,
    fixExecutionActive,
  });

  const catalog = agentContext.modelCatalog ?? bundledModelCatalog();
  const switchModels: Record<string, { model: string | null; label: string }[]> = {};
  for (const id of IMPLEMENTED_PROVIDERS) {
    // A preset is a (core, model) pair: its model is the default only for the
    // effective preset's OWN core. Every other core resolves against the
    // legacy manifest default, so the preset's model never crosses onto a
    // core it was not declared for — and cannot prefill one.
    const coreDefaultModel =
      id === resolvedProvider ? (defaults.model ?? null) : (agentContext.defaultModel ?? null);
    switchModels[id] = agentSwitchModelChoices({
      provider: id,
      ticketModel: ticket.model,
      defaultModel: coreDefaultModel,
      catalog,
    }).map(({ model, label }) => ({ model, label }));
  }
  // The shared picker's inherit rows name the RESOLVED defaults, like the
  // legacy model choices did. Effort inherits the manifest default when the
  // ticket has none.
  const inheritedEffort = resolveEffortForProvider(
    resolvedProvider,
    ticket.effort,
    defaults.effort ?? null,
    agentSession.modelId ?? undefined,
    catalog,
  );
  const effortInheritLabel = inheritedEffort ? `Inherit (settings: ${inheritedEffort})` : 'No effort (agent picks)';
  const modelInheritLabel = agentSession.modelLabel === 'Agent default'
    ? 'No default (agent picks)'
    : agentSession.modelLabel;

  return {
    agentSession,
    agentSwitch: {
      cores: agentSwitchCoreChoices(),
      models: switchModels,
      modelsByCore: catalog,
      recentByCore,
      effort: agentSession.effort,
      modelInheritLabel,
      effortInheritLabel,
      // The core the model/effort inherit labels describe. With an effective
      // identity driving them that is the resolved core, not the manifest's
      // default — an inherited value configured for the identity's core must
      // not be offered under another one.
      inheritCore: impl ? resolvedProvider : (defaultProvider ?? null),
    },
  };
}
