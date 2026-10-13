import type { Store } from '../../store/db.js';
import type { StageKey } from '../../model/types.js';
import type { AgentProvider, Manifest } from '../../manifest/types.js';
import type { ModelCatalog } from '../../agent/modelCatalog.js';
import type { AgentAdapter } from '../../agent/adapter.js';
import type { Notify } from './notify.js';
import {
  agentSwitchCoreChoices,
  agentSwitchModelChoices,
  type AgentSwitchCoreChoice,
  type AgentSwitchModelChoice,
} from '../../agent/sessionSwitch.js';
import {
  listOpenParks,
  claimUsageLimitPark,
  type UsageLimitParkRow,
} from '../../store/usageLimitParks.js';
import {
  rerunParkedStage,
  dismissUsageLimitPark,
} from '../../workflow/usageLimitRerun.js';

export interface QuickPickChoice {
  label: string;
  description?: string;
  detail?: string;
}

export interface QuickPickCoreChoice extends QuickPickChoice {
  id: AgentProvider;
}

export interface QuickPickModelChoice extends QuickPickChoice {
  model: string | null;
}

/** Formats agent core choices, tagging the parked provider with (usage limit). */
export function formatCoreChoices(parkedProvider: string): QuickPickCoreChoice[] {
  return agentSwitchCoreChoices().map((choice) => ({
    id: choice.id,
    label: choice.id === parkedProvider ? `${choice.label} (usage limit)` : choice.label,
  }));
}

/** Formats model choices for a provider, tagging the parked model with (usage limit). */
export function formatModelChoices(
  provider: AgentProvider,
  catalog: ModelCatalog,
  parkedModel: string | null,
): QuickPickModelChoice[] {
  const choices = agentSwitchModelChoices({
    provider,
    ticketModel: null,
    defaultModel: null,
    catalog,
  });

  return choices.map((choice) => {
    const isParked = parkedModel !== null && choice.model === parkedModel;
    return {
      model: choice.model,
      label: choice.label,
      description: isParked
        ? choice.description ? `${choice.description} (usage limit)` : '(usage limit)'
        : choice.description,
    };
  });
}

function findTargetPark(store: Store, ticketId: number, stageKey: StageKey): UsageLimitParkRow | null {
  const open = listOpenParks(store, ticketId);
  return open.find((p) => p.stage === stageKey) ?? null;
}

export interface UsageLimitActionCommonDeps {
  store: Store;
  ticketId: number;
  stageKey: StageKey;
  notify: Notify;
  redrive: (ticketId: number) => void;
  refresh: (ticketId: number) => void;
  manifest?: () => Manifest | undefined;
  artifactDir?: string;
  cwd?: string;
  debug?: (msg: string) => void;
}

export interface UsageLimitPickDeps extends UsageLimitActionCommonDeps {
  catalog: ModelCatalog;
  pickCore: (items: QuickPickCoreChoice[]) => Promise<QuickPickCoreChoice | undefined>;
  pickModel: (items: QuickPickModelChoice[]) => Promise<QuickPickModelChoice | undefined>;
  adapterFor: (provider: AgentProvider, model: string | null) => AgentAdapter;
}

export async function handleUsageLimitPick(deps: UsageLimitPickDeps): Promise<void> {
  const park = findTargetPark(deps.store, deps.ticketId, deps.stageKey);
  if (!park) {
    deps.notify.warn('This usage limit was already handled.');
    return;
  }

  const coreChoices = formatCoreChoices(park.provider);
  const pickedCore = await deps.pickCore(coreChoices);
  if (!pickedCore) return;

  const modelChoices = formatModelChoices(pickedCore.id, deps.catalog, park.model);
  const pickedModel = await deps.pickModel(modelChoices);
  if (!pickedModel) return;

  // Claim then build
  const claimResult = claimUsageLimitPark(deps.store, park.id, 'pick');
  if (!claimResult.claimed || !claimResult.park) {
    deps.notify.warn('This usage limit was already handled.');
    return;
  }

  const adapter = deps.adapterFor(pickedCore.id, pickedModel.model);
  const manifest = deps.manifest?.();

  await rerunParkedStage({
    store: deps.store,
    parkRow: claimResult.park,
    provider: pickedCore.id,
    model: pickedModel.model,
    adapter,
    manifest,
    cwd: deps.cwd ?? process.cwd(),
    artifactDir: deps.artifactDir ?? '',
    debug: deps.debug,
  });

  deps.redrive(deps.ticketId);
  deps.refresh(deps.ticketId);
}

export interface UsageLimitRetryDeps extends UsageLimitActionCommonDeps {
  adapterFor: (provider: AgentProvider, model: string | null) => AgentAdapter;
}

export async function handleUsageLimitRetry(deps: UsageLimitRetryDeps): Promise<void> {
  const park = findTargetPark(deps.store, deps.ticketId, deps.stageKey);
  if (!park) {
    deps.notify.warn('This usage limit was already handled.');
    return;
  }

  const claimResult = claimUsageLimitPark(deps.store, park.id, 'retry');
  if (!claimResult.claimed || !claimResult.park) {
    deps.notify.warn('This usage limit was already handled.');
    return;
  }

  const adapter = deps.adapterFor(claimResult.park.provider as AgentProvider, claimResult.park.model);
  const manifest = deps.manifest?.();

  await rerunParkedStage({
    store: deps.store,
    parkRow: claimResult.park,
    provider: claimResult.park.provider as AgentProvider,
    model: claimResult.park.model,
    adapter,
    manifest,
    cwd: deps.cwd ?? process.cwd(),
    artifactDir: deps.artifactDir ?? '',
    debug: deps.debug,
  });

  deps.redrive(deps.ticketId);
  deps.refresh(deps.ticketId);
}

export interface UsageLimitDismissDeps extends UsageLimitActionCommonDeps {}

export async function handleUsageLimitDismiss(deps: UsageLimitDismissDeps): Promise<void> {
  const park = findTargetPark(deps.store, deps.ticketId, deps.stageKey);
  if (!park) {
    deps.notify.warn('This usage limit was already handled.');
    return;
  }

  dismissUsageLimitPark(deps.store, park, {
    manifest: deps.manifest?.(),
    artifactDir: deps.artifactDir,
    debug: deps.debug,
  });

  deps.redrive(deps.ticketId);
  deps.refresh(deps.ticketId);
}

export interface UsageLimitParkActionsDeps {
  store: Store;
  ticketId: number;
  notify: Notify;
  catalog: () => ModelCatalog;
  manifest: () => Manifest | undefined;
  redrive: (ticketId: number) => void;
  refresh: (ticketId: number) => void;
  pickCore: (items: QuickPickCoreChoice[]) => Promise<QuickPickCoreChoice | undefined>;
  pickModel: (items: QuickPickModelChoice[]) => Promise<QuickPickModelChoice | undefined>;
  adapterFor: (provider: AgentProvider, model: string | null) => AgentAdapter;
  artifactDir: () => string;
  cwd?: () => string;
  debug?: (msg: string) => void;
}

export interface UsageLimitParkActions {
  usageLimitPick: (ticketId: number, stageKey: StageKey) => Promise<void>;
  usageLimitRetry: (ticketId: number, stageKey: StageKey) => Promise<void>;
  usageLimitDismiss: (ticketId: number, stageKey: StageKey) => Promise<void>;
}

export function makeUsageLimitParkActions(deps: UsageLimitParkActionsDeps): UsageLimitParkActions {
  return {
    usageLimitPick: (ticketId: number, stageKey: StageKey) =>
      handleUsageLimitPick({
        store: deps.store,
        ticketId,
        stageKey,
        notify: deps.notify,
        catalog: deps.catalog(),
        manifest: deps.manifest,
        redrive: deps.redrive,
        refresh: deps.refresh,
        pickCore: deps.pickCore,
        pickModel: deps.pickModel,
        adapterFor: deps.adapterFor,
        artifactDir: deps.artifactDir(),
        cwd: deps.cwd?.(),
        debug: deps.debug,
      }),
    usageLimitRetry: (ticketId: number, stageKey: StageKey) =>
      handleUsageLimitRetry({
        store: deps.store,
        ticketId,
        stageKey,
        notify: deps.notify,
        manifest: deps.manifest,
        redrive: deps.redrive,
        refresh: deps.refresh,
        adapterFor: deps.adapterFor,
        artifactDir: deps.artifactDir(),
        cwd: deps.cwd?.(),
        debug: deps.debug,
      }),
    usageLimitDismiss: (ticketId: number, stageKey: StageKey) =>
      handleUsageLimitDismiss({
        store: deps.store,
        ticketId,
        stageKey,
        notify: deps.notify,
        manifest: deps.manifest,
        redrive: deps.redrive,
        refresh: deps.refresh,
        artifactDir: deps.artifactDir(),
        debug: deps.debug,
      }),
  };
}
