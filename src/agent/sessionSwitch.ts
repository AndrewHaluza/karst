import type { AgentProvider } from '../manifest/types.js';
import type { ModelCatalog } from './modelCatalog.js';
import {
  isModelCompatibleWithProvider,
  modelsForProvider,
  resolveModelForProvider,
} from './models.js';
import { IMPLEMENTED_PROVIDERS, isKnownProvider } from './provider.js';
import { AGENT_PROVIDER_LABELS } from '../model/agentIdentity.js';

/**
 * The provider display names — ONE source of truth: the agent identity
 * registry (`model/agentIdentity.ts`). This module used to carry its own
 * copy, so a rename there silently drifted the switch flow (869eh44n5).
 */
export const PROVIDER_LABELS: Readonly<Record<AgentProvider, string>> = AGENT_PROVIDER_LABELS;

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
  /** A running Fix process currently owns the session and may not be switched. */
  fixExecutionActive?: boolean;
}

export interface AgentSwitchCoreChoice { id: AgentProvider; label: string }

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
  fixExecutionActive?: boolean;
}

export interface AgentSwitchFlowDeps {
  read(): AgentSwitchSnapshot;
  isSessionOpen(): boolean;
  isProviderReady(provider: AgentProvider): Promise<boolean>;
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

export function canSwitchAgentSession(
  stageCurrent: string | null,
  sessionOpen: boolean,
  fixExecutionActive = false,
): boolean {
  return sessionOpen
    && (stageCurrent === 'impl' || stageCurrent === 'fix')
    && !(stageCurrent === 'fix' && fixExecutionActive);
}

/** Every implemented core with its canonical label — the header select lists ALL of them. */
export function agentSwitchCoreChoices(): AgentSwitchCoreChoice[] {
  return IMPLEMENTED_PROVIDERS.map((id) => ({ id, label: PROVIDER_LABELS[id] }));
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
    canSwitch: canSwitchAgentSession(
      input.stageCurrent,
      input.sessionOpen,
      input.fixExecutionActive,
    ),
  };
}

export async function applyAgentSwitchSelection(
  deps: AgentSwitchFlowDeps,
  catalog: ModelCatalog,
  selection: { provider: AgentProvider; model: string | null },
): Promise<AgentSwitchOutcome> {
  if (!isKnownProvider(selection.provider)) return { kind: 'stale' };
  const initial = deps.read();
  if (!canSwitchAgentSession(initial.stageCurrent, deps.isSessionOpen(), initial.fixExecutionActive)) {
    return { kind: 'stale' };
  }
  // The staged model must be one of the choices the webview was built from —
  // the host re-validates its own offer, never the webview's word.
  const modelChoices = agentSwitchModelChoices({
    provider: selection.provider,
    ticketModel: initial.ticketModel,
    defaultModel: initial.defaultModel,
    catalog,
  });
  if (!modelChoices.some((choice) => choice.model === selection.model)) return { kind: 'stale' };

  const from = buildAgentSessionView({ ...initial, catalog, sessionOpen: true });
  const to = buildAgentSessionView({
    provider: selection.provider,
    ticketModel: selection.model,
    defaultModel: initial.defaultModel,
    catalog,
    stageCurrent: initial.stageCurrent,
    sessionOpen: false,
  });
  // Only a changed core needs a readiness probe; the current one is already running.
  if (selection.provider !== initial.provider && !(await deps.isProviderReady(selection.provider))) {
    return { kind: 'unavailable', provider: selection.provider };
  }
  if (!(await deps.confirm({ from, to }))) return { kind: 'cancelled', at: 'confirm' };

  const current = deps.read();
  if (!canSwitchAgentSession(current.stageCurrent, deps.isSessionOpen(), current.fixExecutionActive)) {
    return { kind: 'stale' };
  }
  deps.persist({ provider: selection.provider, model: selection.model });
  deps.dispose();
  try {
    await deps.launch({ allowResume: false, providerReady: true });
    return { kind: 'switched' };
  } catch (error) {
    return { kind: 'launch-failed', error };
  }
}
