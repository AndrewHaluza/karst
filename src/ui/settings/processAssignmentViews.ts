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
 *   disabled → unknown-profile → unknown-provider → catalog-unavailable →
 *   incompatible-model → omitted → valid.
 */
import type {
  AgentProvider,
  Manifest,
  ProcessAssignmentConfig,
} from '../../manifest/types.js';
import { PROCESS_KEYS, PROCESS_ROLE_BY_KEY, type ProcessKey } from '../../manifest/validate/processAssignments.js';
import { IMPLEMENTED_PROVIDERS, resolveProvider } from '../../agent/provider.js';
import {
  isModelCompatibleWithProvider,
  resolveModelForProvider,
} from '../../agent/models.js';
import { DEFAULT_PROCESS_AGENT_NAMES } from '../../agent/processAssignment.js';
import { AGENT_PROVIDER_LABELS } from '../../model/agentIdentity.js';
import { bundledModelCatalog, type ModelCatalog } from '../../agent/modelCatalog.js';

/** The handoff §7 assignment states; the four new ones are the last four. */
export type ProcessAssignmentState =
  | 'valid'
  | 'omitted'
  | 'disabled'
  | 'unknown-profile'
  | 'unknown-provider'
  | 'incompatible-model'
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
  invalidField: 'agent' | 'provider' | 'model' | null;
  /** Agent pool names offered by the Agent profile select. */
  profileOptions: readonly string[];
  /**
   * The core the model picker keys off — the row's own provider, else the
   * manifest default. NULL when the row's provider is unknown: no model picker
   * claim is made for an unknown core.
   */
  effectiveProvider: AgentProvider | null;
  /** 'Default: UAT Agent' when no profile is set; '' otherwise. */
  profileHint: string;
  /** 'Default: Claude Code' when no core is set; '' otherwise. */
  coreHint: string;
  /** 'Default: Sonnet 5' when no model is set and a default resolves; ''. */
  modelHint: string;
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
  // are the approved role names. The core default follows the manifest.
  const manifestCore = resolveProvider(undefined, manifest.agentProvider);
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

  // The model that WOULD launch for this row: the manifest default, run through
  // the same provider-compatibility check the launch path applies.
  let modelHint = '';
  if (cfg.model === undefined && effectiveProvider !== null) {
    const resolved = resolveModelForProvider(effectiveProvider, null, manifest.defaultModel, catalog);
    if (resolved !== undefined) {
      const label = catalog[effectiveProvider].find((m) => m.id === resolved)?.label;
      modelHint = `Default: ${label ?? resolved}`;
    }
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
  } else if (cfg.agent === undefined && provider === undefined && cfg.model === undefined) {
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
    effectiveProvider,
    profileHint,
    coreHint,
    modelHint,
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
