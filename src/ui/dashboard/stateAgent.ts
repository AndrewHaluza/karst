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
 * A preset is a (core, model) pair: its model is the default only for the
 * preset's OWN core, so every core's choices resolve against that core's own
 * defaults — switching to another core inherits nothing from the preset and
 * cannot prefill its model.
 */
export function buildAgentState(input: AgentStateInput): AgentStateView {
  const { ticket, fixExecutionActive, defaultProvider, agentContext, recentByCore } = input;
  const defaults = agentContext.defaultsFor?.(ticket.agentPreset, ticket.agentProvider) ?? {
    provider: defaultProvider ?? 'claude',
    model: agentContext.defaultModel ?? undefined,
    effort: agentContext.defaultEffort ?? undefined,
  };
  // `defaultsFor` already folds the ticket provider into `defaults.provider`;
  // without it (no manifest) the ticket's own provider still wins over the
  // manifest default, so the resolve stays here.
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
    // preset's OWN core. Resolve per core so switching to another core does not
    // inherit — and cannot prefill — the preset's model.
    const coreDefaults = agentContext.defaultsFor?.(ticket.agentPreset, id) ?? defaults;
    switchModels[id] = agentSwitchModelChoices({
      provider: id,
      ticketModel: ticket.model,
      defaultModel: coreDefaults.model ?? null,
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
      inheritCore: defaultProvider ?? null,
    },
  };
}
