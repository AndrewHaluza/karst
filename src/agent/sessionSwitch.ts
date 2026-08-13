import type { AgentProvider } from '../manifest/types.js';
import type { ModelCatalog } from './modelCatalog.js';
import {
  isModelCompatibleWithProvider,
  modelsForProvider,
  resolveEffortForProvider,
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
  effort: string | null;
  canSwitch: boolean;
}

export interface AgentSessionViewInput {
  provider: AgentProvider;
  ticketModel: string | null;
  defaultModel: string | null;
  /** Per-ticket effort override (ticket `effort` column); `null` = inherit default. */
  ticketEffort?: string | null;
  /** Manifest default effort; `null` = no default. */
  defaultEffort?: string | null;
  catalog: ModelCatalog;
  stageCurrent: string | null;
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

export interface AgentSwitchSelection { provider: AgentProvider; model: string | null; effort: string | null }
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
  ticketEffort: string | null;
  defaultEffort: string | null;
  fixExecutionActive?: boolean;
}

export interface AgentSwitchFlowDeps {
  read(): AgentSwitchSnapshot;
  isSessionOpen(): boolean;
  isProviderReady(provider: AgentProvider): Promise<boolean>;
  /** `willReplaceSession` lets the host word its dialog: a live session is being
   *  closed; with none open the switch only changes which core the next session
   *  launches with. */
  confirm(input: { from: AgentSessionView; to: AgentSessionView; willReplaceSession: boolean }): Promise<boolean>;
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

/**
 * Whether the header agent-core switch is offered at all. It is available at
 * EVERY stage — impl, the gate stages, ship, done and scope — whether or not a
 * live session is open (869ehtcmz): a provider that hit its usage limit must
 * be replaceable wherever the ticket is, or the work gets stuck. The ONE
 * withheld state is a running Fix recovery execution, which owns the live
 * session and must not be interrupted mid-run.
 */
export function canSwitchAgentSession(
  stageCurrent: string | null,
  fixExecutionActive = false,
): boolean {
  return !(stageCurrent === 'fix' && fixExecutionActive);
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
  const effort = resolveEffortForProvider(
    input.provider,
    input.ticketEffort ?? null,
    input.defaultEffort ?? null,
    modelId,
    input.catalog,
  );
  return {
    provider: input.provider,
    providerLabel: PROVIDER_LABELS[input.provider],
    modelId: modelId ?? null,
    modelLabel: labelForModel(input.provider, modelId, input.catalog),
    effort: effort ?? null,
    canSwitch: canSwitchAgentSession(
      input.stageCurrent,
      input.fixExecutionActive,
    ),
  };
}

export async function applyAgentSwitchSelection(
  deps: AgentSwitchFlowDeps,
  catalog: ModelCatalog,
  selection: AgentSwitchSelection,
): Promise<AgentSwitchOutcome> {
  if (!isKnownProvider(selection.provider)) return { kind: 'stale' };
  const initial = deps.read();
  if (!canSwitchAgentSession(initial.stageCurrent, initial.fixExecutionActive)) {
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

  // The staged effort must be advertised by the SELECTED model — the same
  // validation the launch path applies (`resolveEffortForProvider`), so a
  // staged effort the model does not advertise is refused here rather than
  // silently dropped at launch.
  const toEffort = resolveEffortForProvider(
    selection.provider,
    selection.effort,
    initial.defaultEffort,
    selection.model ?? undefined,
    catalog,
  );

  // Whether a live session is open decides two things: the dialog's wording
  // (a live session is replaced; with none open the change just takes effect
  // for the next session) and whether anything needs disposing.
  const willReplaceSession = deps.isSessionOpen();
  const from = buildAgentSessionView({ ...initial, catalog });
  const to = buildAgentSessionView({
    provider: selection.provider,
    ticketModel: selection.model,
    defaultModel: initial.defaultModel,
    ticketEffort: selection.effort,
    defaultEffort: initial.defaultEffort,
    catalog,
    stageCurrent: initial.stageCurrent,
  });
  // Only a changed core needs a readiness probe; the current one is already running.
  if (selection.provider !== initial.provider && !(await deps.isProviderReady(selection.provider))) {
    return { kind: 'unavailable', provider: selection.provider };
  }
  if (!(await deps.confirm({ from, to, willReplaceSession }))) return { kind: 'cancelled', at: 'confirm' };

  const current = deps.read();
  if (!canSwitchAgentSession(current.stageCurrent, current.fixExecutionActive)) {
    return { kind: 'stale' };
  }
  // The persisted effort is the RESOLVED value: a staged effort the selected
  // model does not advertise is stored as NULL (inherit), never as a value the
  // launch would drop anyway.
  deps.persist({ provider: selection.provider, model: selection.model, effort: toEffort ?? null });
  // Re-check the session after the confirmation modal: it may have opened or
  // closed while the user was deciding, and only a live session needs disposing.
  if (deps.isSessionOpen()) deps.dispose();
  try {
    await deps.launch({ allowResume: false, providerReady: true });
    return { kind: 'switched' };
  } catch (error) {
    return { kind: 'launch-failed', error };
  }
}
