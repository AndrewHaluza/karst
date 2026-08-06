import type { AgentProvider } from '../manifest/types.js';
import type { ModelCatalog } from './modelCatalog.js';
import {
  isModelCompatibleWithProvider,
  modelsForProvider,
  resolveModelForProvider,
} from './models.js';
import { IMPLEMENTED_PROVIDERS } from './provider.js';

export const PROVIDER_LABELS: Readonly<Record<AgentProvider, string>> = {
  claude: 'Claude Code', codex: 'Codex', antigravity: 'Antigravity', opencode: 'OpenCode',
};

export interface AgentSessionView {
  provider: AgentProvider;
  providerLabel: string;
  modelId: string | null;
  modelLabel: string;
  canSwitch: boolean;
}

export interface AgentSessionViewInput {
  provider: AgentProvider;
  ticketModel: string | null;
  defaultModel: string | null;
  catalog: ModelCatalog;
  stageCurrent: string | null;
  sessionOpen: boolean;
}

export interface AgentSwitchProviderChoice { provider: AgentProvider; label: string }

export interface AgentSwitchModelChoicesInput {
  provider: AgentProvider;
  ticketModel: string | null;
  defaultModel: string | null;
  catalog: ModelCatalog;
}

export interface AgentSwitchModelChoice {
  model: string | null;
  label: string;
  description: string;
  picked: boolean;
}

export interface AgentSwitchSelection { provider: AgentProvider; model: string | null }
export interface AgentSwitchLaunchOptions {
  allowResume: false;
  /** The candidate provider passed the coordinator's async readiness probe. */
  providerReady: true;
}

export interface AgentSwitchSnapshot {
  stageCurrent: string | null;
  provider: AgentProvider;
  ticketModel: string | null;
  defaultModel: string | null;
}

export interface AgentSwitchFlowDeps {
  read(): AgentSwitchSnapshot;
  isSessionOpen(): boolean;
  pickProvider(
    choices: readonly AgentSwitchProviderChoice[],
    current: AgentSessionView,
  ): Promise<AgentProvider | undefined>;
  isProviderReady(provider: AgentProvider): Promise<boolean>;
  pickModel(
    provider: AgentProvider,
    choices: readonly AgentSwitchModelChoice[],
  ): Promise<AgentSwitchModelChoice | undefined>;
  confirm(input: { from: AgentSessionView; to: AgentSessionView }): Promise<boolean>;
  persist(selection: AgentSwitchSelection): void;
  dispose(): void;
  launch(options: AgentSwitchLaunchOptions): Promise<void>;
}

export type AgentSwitchOutcome =
  | { kind: 'switched' }
  | { kind: 'cancelled'; at: 'provider' | 'model' | 'confirm' }
  | { kind: 'unavailable'; provider: AgentProvider }
  | { kind: 'stale' }
  | { kind: 'launch-failed'; error: unknown };

function labelForModel(provider: AgentProvider, id: string | undefined, catalog: ModelCatalog): string {
  if (!id) return 'Agent default';
  return modelsForProvider(provider, catalog).find((model) => model.id === id)?.label ?? id;
}

export function canSwitchAgentSession(stageCurrent: string | null, sessionOpen: boolean): boolean {
  return sessionOpen && (stageCurrent === 'impl' || stageCurrent === 'fix');
}

export function agentSwitchProviderChoices(current: AgentProvider): AgentSwitchProviderChoice[] {
  return IMPLEMENTED_PROVIDERS
    .filter((provider) => provider !== current)
    .map((provider) => ({ provider, label: PROVIDER_LABELS[provider] }));
}

export function agentSwitchModelChoices(input: AgentSwitchModelChoicesInput): AgentSwitchModelChoice[] {
  const { provider, ticketModel, defaultModel, catalog } = input;
  const compatibleTicket = ticketModel
    && isModelCompatibleWithProvider(provider, ticketModel, catalog)
    && modelsForProvider(provider, catalog).some((model) => model.id === ticketModel)
      ? ticketModel
      : null;
  const inherited = resolveModelForProvider(provider, null, defaultModel, catalog);
  return [
    {
      model: null,
      label: inherited ? `Inherit (settings: ${labelForModel(provider, inherited, catalog)})` : 'Agent default',
      description: inherited ?? 'Let the agent choose',
      picked: compatibleTicket === null,
    },
    ...modelsForProvider(provider, catalog).map((model) => ({
      model: model.id,
      label: model.label,
      description: model.id,
      picked: model.id === compatibleTicket,
    })),
  ];
}

export function buildAgentSessionView(input: AgentSessionViewInput): AgentSessionView {
  const modelId = resolveModelForProvider(
    input.provider, input.ticketModel, input.defaultModel, input.catalog,
  );
  return {
    provider: input.provider,
    providerLabel: PROVIDER_LABELS[input.provider],
    modelId: modelId ?? null,
    modelLabel: labelForModel(input.provider, modelId, input.catalog),
    canSwitch: canSwitchAgentSession(input.stageCurrent, input.sessionOpen),
  };
}

export async function runAgentSwitchFlow(
  deps: AgentSwitchFlowDeps,
  catalog: ModelCatalog,
): Promise<AgentSwitchOutcome> {
  const initial = deps.read();
  if (!canSwitchAgentSession(initial.stageCurrent, deps.isSessionOpen())) return { kind: 'stale' };

  const from = buildAgentSessionView({ ...initial, catalog, sessionOpen: true });
  const provider = await deps.pickProvider(agentSwitchProviderChoices(initial.provider), from);
  if (provider === undefined) return { kind: 'cancelled', at: 'provider' };
  if (provider === initial.provider) return { kind: 'stale' };
  if (!await deps.isProviderReady(provider)) return { kind: 'unavailable', provider };

  const modelChoices = agentSwitchModelChoices({
    provider,
    ticketModel: initial.ticketModel,
    defaultModel: initial.defaultModel,
    catalog,
  });
  const modelChoice = await deps.pickModel(provider, modelChoices);
  if (modelChoice === undefined) return { kind: 'cancelled', at: 'model' };
  if (!modelChoices.some((choice) => choice.model === modelChoice.model)) return { kind: 'stale' };

  const to = buildAgentSessionView({
    provider,
    ticketModel: modelChoice.model,
    defaultModel: initial.defaultModel,
    catalog,
    stageCurrent: initial.stageCurrent,
    sessionOpen: false,
  });
  if (!await deps.confirm({ from, to })) return { kind: 'cancelled', at: 'confirm' };

  const current = deps.read();
  if (
    current.provider !== initial.provider
    || !canSwitchAgentSession(current.stageCurrent, deps.isSessionOpen())
  ) return { kind: 'stale' };

  deps.persist({ provider, model: modelChoice.model });
  deps.dispose();
  try {
    await deps.launch({ allowResume: false, providerReady: true });
    return { kind: 'switched' };
  } catch (error) {
    return { kind: 'launch-failed', error };
  }
}
