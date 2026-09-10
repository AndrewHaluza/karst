/**
 * The curated set of launch models offered per-ticket and as the manifest
 * default (§ model selection). vscode-free so it is unit-testable and shared by
 * the store, the launch path, and (mirrored, since a webview can't import TS)
 * the ticket-form + settings HTML. `resolveModel` is the single precedence rule.
 */

import type { AgentProvider } from '../manifest/types.js';
import { bundledModelCatalog, type ModelCatalog, type ModelOption } from './modelCatalog.js';

export type { ModelOption } from './modelCatalog.js';

/**
 * Offered models, newest/most-capable first. Ids are the exact CLI `--model`
 * values. Keep in sync with the mirrored lists in the ticket-form + settings
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
    opencode: merge('opencode'),
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

/**
 * Resolve the effective effort/variant for a launch: the ticket's own effort
 * wins, else the manifest default. The effort is only meaningful for a model
 * that advertises it, so a candidate is carried only when the RESOLVED model
 * for that provider advertises it (the save-time validation in `effort.ts`
 * already refused an unsupported one; this guards a catalog change in between
 * that removed the value). Absent → the agent CLI's own default applies.
 */
export function resolveEffortForProvider(
  provider: AgentProvider,
  ticketEffort: string | null | undefined,
  defaultEffort: string | null | undefined,
  modelId: string | undefined,
  catalog: ModelCatalog = bundledModelCatalog(),
): string | undefined {
  for (const candidate of [ticketEffort, defaultEffort]) {
    const value = firstNonBlank(candidate);
    if (!value) continue;
    const efforts = catalog[provider].find((m) => m.id === modelId)?.efforts;
    // No model resolved → no model to cross-check → the effort cannot be used.
    if (modelId === undefined || efforts === undefined) continue;
    if (efforts.includes(value)) return value;
  }
  return undefined;
}

/**
 * The ordered model chain one AI call may walk when the provider refuses a
 * model (§ retry and model fallback). The resolved launch model is always
 * FIRST — a fallback is a fallback, never a substitution. Each configured
 * fallback is kept only when it is non-blank, compatible with the calling
 * provider (`isModelCompatibleWithProvider`, which accepts ids the catalog
 * does not know so a preview/custom id still works), and not already in the
 * chain.
 *
 * `resolved === undefined` means "let the CLI pick its own default". The
 * chain then LEADS with `undefined` and the fallbacks follow it, so a
 * CLI-default call that the provider refuses can still recover.
 */
export function resolveModelChain(
  provider: AgentProvider,
  resolved: string | undefined,
  fallbacks: readonly string[] | undefined,
  catalog: ModelCatalog = bundledModelCatalog(),
): readonly (string | undefined)[] {
  const chain: (string | undefined)[] = [resolved];
  const seen = new Set<string>(resolved !== undefined ? [resolved] : []);
  for (const candidate of fallbacks ?? []) {
    const id = candidate.trim();
    if (id === '' || seen.has(id)) continue;
    if (!isModelCompatibleWithProvider(provider, id, catalog)) continue;
    seen.add(id);
    chain.push(id);
  }
  return chain;
}
