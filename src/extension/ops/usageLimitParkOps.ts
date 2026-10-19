import type { Store } from '../../store/db.js';
import type { StageKey } from '../../model/types.js';
import type { AgentProvider, Manifest } from '../../manifest/types.js';
import type { ModelCatalog } from '../../agent/modelCatalog.js';
import type { AgentAdapter } from '../../agent/adapter.js';
import type { Notify } from './notify.js';
import type { GitRunner } from '../../integrations/git.js';
import type { ReviewArtifacts } from '../../workflow/review/conformance.js';
import type { TesterGateRunner } from '../../workflow/uat/testerVerifier.js';
import {
  agentSwitchCoreChoices,
  agentSwitchModelChoices,
  type AgentSwitchCoreChoice,
  type AgentSwitchModelChoice,
} from '../../agent/sessionSwitch.js';
import { stageBlock } from '../../store/stageBlocks.js';
import {
  listOpenParks,
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
        ? `${choice.description} (usage limit)`
        : choice.description,
    };
  });
}

function findTargetPark(store: Store, ticketId: number, stageKey: StageKey): UsageLimitParkRow | null {
  const atStage = listOpenParks(store, ticketId).filter((p) => p.stage === stageKey);
  if (atStage.length === 0) {
    return null;
  }
  // A usage-limit STAGE BLOCK is what the dashboard banner speaks for, and it
  // always carries its own `stage-block` park. A sibling `op` park (classify,
  // analysis, suggest) merely RAN at the same stage and can be newer, so
  // selecting by stage alone would hijack the stage action onto an unrelated
  // op. When the stage is blocked on usage-limit, target THAT park.
  const block = stageBlock(store, ticketId, stageKey);
  if (block?.kind === 'usage-limit') {
    return atStage.find((p) => p.kind === 'stage-block') ?? null;
  }
  // No usage-limit block: an op park at this stage is the target (the op-park
  // notification path). A stage-block park whose block is already gone is
  // stale and must not be actioned.
  return atStage.find((p) => p.kind === 'op') ?? null;
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
  /**
   * The git runner the review re-run snapshots the worktree with, so it reviews
   * the SAME committed+uncommitted tree the stage would — never a committed-only
   * range. Absent → no snapshot (fallback wording); the host passes the real one.
   */
  git?: GitRunner;
  /** Review conformance artifacts for the re-run; absent → the lane runs without them. */
  loadArtifacts?: (ticketId: number) => Promise<ReviewArtifacts | undefined>;
  /** The `uat.testerVerifier` host boundary (`runProcess`); absent → a configured verifier parks. */
  runVerifier?: TesterGateRunner;
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

  const manifest = deps.manifest?.();

  const result = await rerunParkedStage({
    store: deps.store,
    parkRow: park,
    provider: pickedCore.id,
    model: pickedModel.model,
    resolution: 'pick',
    // Built only if the claim wins (inside `rerunParkedStage`), so a racing
    // window never constructs an adapter it will not use.
    buildAdapter: deps.adapterFor,
    manifest,
    cwd: deps.cwd ?? process.cwd(),
    artifactDir: deps.artifactDir ?? '',
    git: deps.git,
    loadArtifacts: deps.loadArtifacts ? () => deps.loadArtifacts!(deps.ticketId) : undefined,
    runVerifier: deps.runVerifier,
    debug: deps.debug,
  });

  if (result.kind === 'stopped') {
    deps.notify.warn('This usage limit was already handled.');
    return;
  }

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

  const manifest = deps.manifest?.();

  const result = await rerunParkedStage({
    store: deps.store,
    parkRow: park,
    provider: park.provider as AgentProvider,
    model: park.model,
    resolution: 'retry',
    // Built only if the claim wins (inside `rerunParkedStage`).
    buildAdapter: deps.adapterFor,
    manifest,
    cwd: deps.cwd ?? process.cwd(),
    artifactDir: deps.artifactDir ?? '',
    git: deps.git,
    loadArtifacts: deps.loadArtifacts ? () => deps.loadArtifacts!(deps.ticketId) : undefined,
    runVerifier: deps.runVerifier,
    debug: deps.debug,
  });

  if (result.kind === 'stopped') {
    deps.notify.warn('This usage limit was already handled.');
    return;
  }

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

  const result = dismissUsageLimitPark(deps.store, park, {
    manifest: deps.manifest?.(),
    artifactDir: deps.artifactDir,
    debug: deps.debug,
  });

  if (result.kind === 'stopped') {
    deps.notify.warn('This usage limit was already handled.');
    return;
  }

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
  git?: GitRunner;
  loadArtifacts?: (ticketId: number) => Promise<ReviewArtifacts | undefined>;
  runVerifier?: TesterGateRunner;
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
        git: deps.git,
        loadArtifacts: deps.loadArtifacts,
        runVerifier: deps.runVerifier,
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
        git: deps.git,
        loadArtifacts: deps.loadArtifacts,
        runVerifier: deps.runVerifier,
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
