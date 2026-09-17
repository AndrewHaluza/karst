/**
 * Per-row views for the Settings → Agents "Inside process assignments"
 * subsection (handoff §7). The WEBVIEW DERIVES NOTHING: every string a row
 * renders — role label, description, the validation states and their inline
 * messages, the Default hints — is computed here, host-side, and shipped to
 * the webview either on the `state` push or on a `validate-process-assignments`
 * round trip (the draft is webview-local, so the states must be re-computed
 * from the posted draft exactly like the existing `validate` flow).
 *
 * Row → manifest mapping (the handoff's three-way distinction):
 *   Agent profile — `processes.<key>.agent`, a reference to a profile in the
 *     agent pool (file agents + approach agents). A value that names no pool
 *     member is the handoff's "Unknown profile": the reference dangles, e.g.
 *     after the profile's file was deleted from the Agents card.
 *   Agent core   — `processes.<key>.provider`, the provider executable. A
 *     value outside the known provider vocabulary is "Unknown provider".
 *   Model        — `processes.<key>.model`, validated against the effective
 *     core through the same compatibility knowledge the launch path uses.
 *   enabled      — `processes.<key>.enabled` (default true).
 *   Display name — `processes.<key>.agentName`, the snapshot display override.
 *
 * State precedence (first match wins):
 *   disabled → unknown-preset → unknown-profile → unknown-provider →
 *   catalog-unavailable → incompatible-model → incompatible-effort → omitted →
 *   valid.
 */
import type {
  AgentProvider,
  Manifest,
  ProcessAssignmentConfig,
} from '../../manifest/types.js';
import { PROCESS_KEYS, PROCESS_ROLE_BY_KEY, type ProcessKey } from '../../manifest/validate/processAssignments.js';
import { IMPLEMENTED_PROVIDERS } from '../../agent/provider.js';
import { resolveAgentDefaults } from '../../agent/agentPresets.js';
import {
  isModelCompatibleWithProvider,
  resolveModelForProvider,
  resolveEffortForProvider,
} from '../../agent/models.js';
import { effortsForModel } from '../../agent/effort.js';
import { DEFAULT_PROCESS_AGENT_NAMES } from '../../agent/processAssignment.js';
import { AGENT_PROVIDER_LABELS } from '../../model/agentIdentity.js';
import { bundledModelCatalog, type ModelCatalog } from '../../agent/modelCatalog.js';

/** The handoff §7 assignment states; the five new ones are the last five. */
export type ProcessAssignmentState =
  | 'valid'
  | 'omitted'
  | 'disabled'
  | 'unknown-preset'
  | 'unknown-profile'
  | 'unknown-provider'
  | 'incompatible-model'
  | 'incompatible-effort'
  | 'catalog-unavailable';

/**
 * Everything one row renders. `profileOptions` is the host-supplied agent
 * pool; the controls' VALUES stay in the draft (the webview binds its inputs
 * to `draft.processes[key]` so a change is reflected instantly, while these
 * strings/states arrive from the host).
 */
export interface SettingsProcessAssignmentView {
  key: ProcessKey;
  /** 'UAT Tester' — the handoff's role label; never the manifest key. */
  roleLabel: string;
  /** Per-row description, e.g. 'Runs after required UAT gates pass'. */
  description: string;
  state: ProcessAssignmentState;
  /** 'error' (unknown-*) or 'note' (disabled / catalog-unavailable). */
  stateTone: 'error' | 'note';
  /** The inline message; '' when the row needs none. */
  stateMessage: string;
  /** Which control the message is about (drives aria-invalid/describedby). */
  invalidField: 'agent' | 'provider' | 'model' | 'effort' | 'preset' | null;
  /** Agent pool names offered by the Agent profile select. */
  profileOptions: readonly string[];
  /** Agent preset names offered by the row's preset select, sorted. */
  presetOptions: readonly string[];
  /** 'Default: fast' when the row names no preset and one is defaulted; '' otherwise. */
  presetHint: string;
  /**
   * The core the model picker keys off — the row's own provider, else the
   * manifest default. NULL when the row's provider is unknown: no model picker
   * claim is made for an unknown core.
   */
  effectiveProvider: AgentProvider | null;
  /**
   * The model the effort/variant picker keys off — the row's own model, else
   * the resolved default for the effective core. Undefined when no model can
   * resolve for the row (no model set and no default): the effort field
   * renders nothing for a model-less row.
   */
  effectiveModel: string | undefined;
  /** 'Default: UAT Agent' when no profile is set; '' otherwise. */
  profileHint: string;
  /** 'Default: Claude Code' when no core is set; '' otherwise. */
  coreHint: string;
  /** 'Default: Sonnet 5' when no model is set and a default resolves; ''. */
  modelHint: string;
  /** 'Default: high' when no effort is set and a default resolves; ''. */
  effortHint: string;
}

/** Handoff §7 role labels — the primary user-facing names. */
const ROLE_LABELS: Record<ProcessKey, string> = {
  uatTester: 'UAT Tester',
  uatFix: 'UAT Fix',
  review: 'Review',
  reviewFix: 'Review Fix',
  prDescription: 'PR description',
  ticketAnalysis: 'Ticket analysis',
};

/** Handoff §7 per-row descriptions (what each process does, when it runs). */
const ROLE_DESCRIPTIONS: Record<ProcessKey, string> = {
  uatTester: 'Runs after required UAT gates pass',
  uatFix: 'Runs to fix a failed UAT gate',
  review: 'Runs after required review gates pass',
  reviewFix: 'Runs to fix a failed review gate',
  prDescription: 'Writes the pull request description at ship time',
  ticketAnalysis:
    'Synthesizes the ticket prompt; suggests approach, repos and type on the ticket form',
};

/**
 * A saved value interpolated into an inline message is manifest data (UI-R32):
 * collapsed to one line and length-capped before it reaches the webview.
 */
function displayName(value: string): string {
  const collapsed = value.replace(/\s+/g, ' ').trim();
  return collapsed.length > 48 ? `${collapsed.slice(0, 48)}…` : collapsed;
}

function coreLabel(provider: AgentProvider): string {
  return AGENT_PROVIDER_LABELS[provider];
}

export function buildProcessAssignmentView(
  key: ProcessKey,
  cfg: ProcessAssignmentConfig,
  manifest: Manifest,
  profileOptions: readonly string[],
  catalog: ModelCatalog = bundledModelCatalog(),
): SettingsProcessAssignmentView {
  const roleLabel = ROLE_LABELS[key];
  const description = ROLE_DESCRIPTIONS[key];

  // The approved defaults: the PR-description role's profile default is the
  // ticket-resolved adapter label (never a fixed agent name), the other roles'
  // are the approved role names. The core default follows the effective preset.
  const presetDefaults = resolveAgentDefaults(manifest, { rolePreset: cfg.preset });
  const presetOptions = Object.keys(manifest.agentPresets ?? {}).sort();
  const presetHint =
    cfg.preset === undefined && manifest.defaultAgentPreset
      ? `Default: ${displayName(manifest.defaultAgentPreset)}`
      : '';
  const manifestCore = presetDefaults.provider;
  const role = PROCESS_ROLE_BY_KEY[key];
  const defaultProfile =
    role === 'pr-description' ? coreLabel(manifestCore) : DEFAULT_PROCESS_AGENT_NAMES[role];
  const profileHint = cfg.agent === undefined ? `Default: ${defaultProfile}` : '';

  const provider = cfg.provider;
  const providerKnown =
    provider !== undefined && (IMPLEMENTED_PROVIDERS as readonly string[]).includes(provider);
  const effectiveProvider: AgentProvider | null = providerKnown
    ? provider
    : provider === undefined
      ? manifestCore
      : null;
  const coreHint =
    provider === undefined ? `Default: ${coreLabel(effectiveProvider as AgentProvider)}` : '';

  // The effective defaults for THIS row: the preset supplies model/effort only
  // when its own core is the one the row will actually run on.
  const defaults = resolveAgentDefaults(manifest, {
    rolePreset: cfg.preset,
    explicitProvider: effectiveProvider,
  });

  // The model that WOULD launch for this row: the manifest default, run through
  // the same provider-compatibility check the launch path applies.
  let modelHint = '';
  let effectiveModel: string | undefined;
  if (effectiveProvider !== null) {
    const resolved = resolveModelForProvider(
      effectiveProvider,
      cfg.model ?? null,
      defaults.model,
      catalog,
    );
    if (cfg.model === undefined && resolved !== undefined) {
      const label = catalog[effectiveProvider].find((m) => m.id === resolved)?.label;
      modelHint = `Default: ${label ?? resolved}`;
    }
    effectiveModel = resolved;
  }

  // The effort/variant that WOULD launch: the resolved default effort, run
  // through the same model-capability check the launch path applies (only a
  // value the resolved model advertises is carried).
  let effortHint = '';
  if (cfg.effort === undefined && effectiveProvider !== null && effectiveModel !== undefined) {
    const resolved = resolveEffortForProvider(
      effectiveProvider,
      null,
      defaults.effort,
      effectiveModel,
      catalog,
    );
    if (resolved !== undefined) effortHint = `Default: ${resolved}`;
  }

  let state: ProcessAssignmentState = 'valid';
  let stateTone: 'error' | 'note' = 'note';
  let stateMessage = '';
  let invalidField: SettingsProcessAssignmentView['invalidField'] = null;

  if (cfg.enabled === false) {
    // Handoff: "Preserve selections but disable execution; explain what will
    // be skipped." Not a fault — a deliberate off switch.
    state = 'disabled';
    stateTone = 'note';
    stateMessage = `Disabled — ${roleLabel} is skipped. Selections are kept.`;
  } else if (cfg.preset !== undefined && !presetOptions.includes(cfg.preset)) {
    // The saved preset names nothing the manifest defines. Reference integrity
    // is refused at manifest load for manifest-level roles, so this is a
    // store/manifest drift the row must name rather than silently ignore.
    state = 'unknown-preset';
    stateTone = 'error';
    stateMessage =
      `Agent preset "${displayName(cfg.preset)}" does not exist. ` +
      'Pick a preset or leave the role default.';
    invalidField = 'preset';
  } else if (cfg.agent !== undefined && !profileOptions.includes(cfg.agent)) {
    // Handoff: "Unknown profile — Inline error naming the missing profile."
    state = 'unknown-profile';
    stateTone = 'error';
    stateMessage =
      `Agent profile "${displayName(cfg.agent)}" does not exist. ` +
      'Pick a profile from the list or leave the role default.';
    invalidField = 'agent';
  } else if (provider !== undefined && !providerKnown) {
    // Handoff: "Unknown provider — Inline error and no model picker claim."
    state = 'unknown-provider';
    stateTone = 'error';
    stateMessage =
      `Agent core "${displayName(provider)}" is not supported. Pick one of the listed cores.`;
    invalidField = 'provider';
  } else if (
    effectiveProvider !== null &&
    cfg.model !== undefined &&
    catalog[effectiveProvider].length === 0
  ) {
    // Handoff: "Provider catalog unavailable — Keep saved id, show unavailable
    // note". The saved model must not read as a validated pick.
    state = 'catalog-unavailable';
    stateTone = 'note';
    stateMessage =
      `No model list is available for ${coreLabel(effectiveProvider)}; the saved model is kept.`;
  } else if (
    effectiveProvider !== null &&
    cfg.model !== undefined &&
    !isModelCompatibleWithProvider(effectiveProvider, cfg.model, catalog)
  ) {
    // Handoff: "Model incompatible with provider — Inline error; do not
    // silently substitute."
    state = 'incompatible-model';
    stateTone = 'error';
    stateMessage =
      `Model "${displayName(cfg.model)}" is not compatible with ${coreLabel(effectiveProvider)}. ` +
      `Pick a model for ${coreLabel(effectiveProvider)}.`;
    invalidField = 'model';
  } else if (
    effectiveProvider !== null &&
    cfg.effort !== undefined &&
    effectiveModel !== undefined &&
    !(effortsForModel(effectiveProvider, effectiveModel, catalog) ?? []).includes(cfg.effort)
  ) {
    // An explicit effort the RESOLVED model does not advertise is a
    // configuration failure, never silently discarded — the same rule the
    // unified picker applies when offering effort values, mirrored here for a
    // hand-authored manifest value the picker never produced.
    state = 'incompatible-effort';
    stateTone = 'error';
    stateMessage =
      `Effort "${displayName(cfg.effort)}" is not advertised by model ` +
      `"${displayName(effectiveModel)}" (${coreLabel(effectiveProvider)}). Pick an advertised effort.`;
    invalidField = 'effort';
  } else if (
    cfg.agent === undefined &&
    provider === undefined &&
    cfg.model === undefined &&
    cfg.effort === undefined
  ) {
    // Handoff: "Assignment omitted — Show approved default and a Default hint."
    state = 'omitted';
  }

  return {
    key,
    roleLabel,
    description,
    state,
    stateTone,
    stateMessage,
    invalidField,
    profileOptions,
    presetOptions,
    presetHint,
    effectiveProvider,
    effectiveModel,
    profileHint,
    coreHint,
    modelHint,
    effortHint,
  };
}

/**
 * One view per inside process, in the closed PROCESS_KEYS order (the same
 * vocabulary `PROCESS_KEY_BY_ROLE` maps roles onto — see
 * manifest/validate/processAssignments.ts).
 */
export function buildProcessAssignmentViews(
  manifest: Manifest,
  profileOptions: readonly string[],
  catalog: ModelCatalog = bundledModelCatalog(),
): SettingsProcessAssignmentView[] {
  return PROCESS_KEYS.map((key) =>
    buildProcessAssignmentView(key, manifest.processes?.[key] ?? {}, manifest, profileOptions, catalog),
  );
}
