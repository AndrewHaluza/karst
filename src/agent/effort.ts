/**
 * Pure effort resolution/validation — vscode-free, catalog-injected.
 *
 * Effort is optional and model-capability-aware (design § Execution policy
 * resolution): an explicitly configured effort the selected model does not
 * advertise is a configuration failure, never silently discarded, and a
 * custom model id typed by the user that is not in the catalog accepts no
 * effort at all. The check needs the LIVE catalog (the feed tier can augment
 * the bundled one), so this module is consumed host-side — at Save for
 * configuration (the settings surface wires it in Slice-1 Task 6), and at
 * launch for late-bound profile resolution. Provider-specific flag
 * translation stays inside the adapters and receives effort as one string
 * value; the capability declarations here stay separate from the CLI
 * bindings so an adapter can gain (or lose) one mode independently.
 */

import type { AgentProvider } from '../manifest/types.js';
import type { ModelCatalog } from './modelCatalog.js';

/** The named configuration-failure error (design: rejected at Save with a
 *  named error, never silently discarded). */
export class EffortError extends Error {
  readonly kind: 'not-cataloged' | 'no-efforts' | 'unadvertised' | 'opencode-pair';

  constructor(kind: EffortError['kind'], message: string) {
    super(message);
    this.name = 'EffortError';
    this.kind = kind;
  }
}

export interface EffortCapability {
  /** The interactive session binding supports effort. */
  interactive: boolean;
  /** The headless run binding supports effort. */
  headless: boolean;
  /**
   * Whether this adapter accepts a BOUNDED custom effort value not in the
   * catalog. Design: "Custom values are retained and attempted only when that
   * adapter explicitly supports custom variants; otherwise Save is rejected."
   * None of the initial bindings declare it — every effort must be advertised
   * by the selected model.
   */
  customValues: boolean;
}

const EFFORT_CAPABILITIES: Readonly<Record<AgentProvider, EffortCapability>> = {
  claude: { interactive: true, headless: true, customValues: false },
  codex: { interactive: true, headless: true, customValues: false },
  antigravity: { interactive: true, headless: true, customValues: false },
  // opencode's interactive TUI (1.18.18) has no `--variant` flag — only
  // `opencode run` accepts it. The adapter must not thread the effort into the
  // TUI (it prints help and exits 1, killing the session at launch), so the
  // interactive binding cannot express effort; headless keeps it.
  opencode: { interactive: false, headless: true, customValues: false },
};

/** The adapter capability declaration for one provider. An adapter whose CLI
 *  exposes no effort flag declares neither mode and renders no effort field. */
export function effortCapabilities(provider: AgentProvider): EffortCapability {
  return EFFORT_CAPABILITIES[provider];
}

/** The effort values one model advertises, or undefined when the model is not
 *  in the catalog or its entry advertises none — both mean "no effort value". */
export function effortsForModel(
  provider: AgentProvider,
  modelId: string,
  catalog: ModelCatalog,
): readonly string[] | undefined {
  return catalog[provider].find((m) => m.id === modelId)?.efforts;
}

/**
 * Validate one profile's effort against the LIVE catalog. Throws `EffortError`
 * (a named error) when the effort is unsupported; never discards silently.
 * An absent/blank effort is fine. `modelId` may be undefined only for
 * opencode, where effort IS the model variant and needs no model lookup.
 */
export function assertProfileEffort(
  provider: AgentProvider,
  modelId: string | undefined,
  effort: string | undefined,
  catalog: ModelCatalog,
): void {
  if (effort === undefined || effort === null || effort === '') return;

  // opencode: effort IS the selected model variant. A profile setting both is
  // a stale, semantically conflicting pair — rejected, not resolved.
  if (provider === 'opencode' && modelId) {
    throw new EffortError(
      'opencode-pair',
      `opencode profiles may set effort OR model, never both — effort IS the model ` +
        `variant (model ${JSON.stringify(modelId)}, effort ${JSON.stringify(effort)})`,
    );
  }
  // opencode effort-only: a variant choice with no model to cross-check.
  if (modelId === undefined) return;

  const efforts = effortsForModel(provider, modelId, catalog);
  if (efforts === undefined) {
    const cataloged = catalog[provider].some((m) => m.id === modelId);
    if (!cataloged) {
      throw new EffortError(
        'not-cataloged',
        `effort ${JSON.stringify(effort)} is configured for model ` +
          `${JSON.stringify(modelId)} (${provider}), which is not in the model ` +
          `catalog — a custom model id accepts no effort value`,
      );
    }
    throw new EffortError(
      'no-efforts',
      `model ${JSON.stringify(modelId)} (${provider}) advertises no effort values — ` +
        `configured effort ${JSON.stringify(effort)} cannot be used`,
    );
  }

  if (!efforts.includes(effort)) {
    throw new EffortError(
      'unadvertised',
      `effort ${JSON.stringify(effort)} is not advertised by model ` +
        `${JSON.stringify(modelId)} (${provider}) — choose one of: ${efforts.join(', ')}`,
    );
  }
}
