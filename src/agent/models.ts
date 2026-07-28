/**
 * The curated set of launch models offered per-ticket and as the manifest
 * default (§ model selection). vscode-free so it is unit-testable and shared by
 * the store, the launch path, and (mirrored, since a webview can't import TS)
 * the onboarding + settings HTML. `resolveModel` is the single precedence rule.
 */

import type { AgentProvider } from '../manifest/types.js';
import { bundledModelCatalog, type ModelCatalog, type ModelOption } from './modelCatalog.js';

export type { ModelOption } from './modelCatalog.js';

/**
 * Offered models, newest/most-capable first. Ids are the exact CLI `--model`
 * values. Keep in sync with the mirrored lists in the onboarding + settings
 * webview HTML (they can't import this module).
 */
export const KNOWN_MODELS = Object.values(bundledModelCatalog()).flat();

export function modelsForProvider(
  provider: AgentProvider,
  catalog: ModelCatalog = bundledModelCatalog(),
): readonly ModelOption[] {
  return catalog[provider];
}

/**
 * Build the provider knowledge used for compatibility decisions. The live
 * catalog can narrow temporarily, so bundled ids remain known while newly
 * discovered ids are added immediately.
 */
export function compatibilityModelCatalog(
  catalog: ModelCatalog = bundledModelCatalog(),
): ModelCatalog {
  const bundled = bundledModelCatalog();
  const merge = (provider: AgentProvider): readonly ModelOption[] => {
    const byId = new Map<string, ModelOption>();
    for (const model of [...bundled[provider], ...catalog[provider]]) {
      byId.set(model.id, model);
    }
    return [...byId.values()];
  };
  return {
    claude: merge('claude'),
    codex: merge('codex'),
    antigravity: merge('antigravity'),
  };
}

/** A blank/whitespace string counts as "unset" (inherit / CLI default). */
function firstNonBlank(...vals: (string | null | undefined)[]): string | undefined {
  for (const v of vals) {
    if (typeof v === 'string' && v.trim() !== '') return v;
  }
  return undefined;
}

/**
 * Resolve the effective launch model: the ticket's own model wins, else the
 * manifest default, else `undefined` (let the agent CLI pick its own default).
 * Blank values at either level are treated as "inherit".
 */
export function resolveModel(
  ticketModel: string | null | undefined,
  defaultModel: string | null | undefined,
): string | undefined {
  return firstNonBlank(ticketModel, defaultModel);
}

export function isModelCompatibleWithProvider(
  provider: AgentProvider,
  id: string,
  catalog: ModelCatalog = bundledModelCatalog(),
): boolean {
  const known = Object.values(compatibilityModelCatalog(catalog))
    .flat()
    .filter((model) => model.id === id);
  return known.length === 0 || known.some((model) => model.providers.includes(provider));
}

/**
 * Resolve the effective model without carrying a known provider-specific
 * selection across an agent-provider switch. Unknown ids remain valid so
 * users can intentionally target preview/custom models not in the curated UI.
 */
export function resolveModelForProvider(
  provider: AgentProvider,
  ticketModel: string | null | undefined,
  defaultModel: string | null | undefined,
  catalog: ModelCatalog = bundledModelCatalog(),
): string | undefined {
  for (const candidate of [ticketModel, defaultModel]) {
    const id = firstNonBlank(candidate);
    if (id && isModelCompatibleWithProvider(provider, id, catalog)) return id;
  }
  return undefined;
}
