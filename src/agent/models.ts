/**
 * The curated set of launch models offered per-ticket and as the manifest
 * default (§ model selection). vscode-free so it is unit-testable and shared by
 * the store, the launch path, and (mirrored, since a webview can't import TS)
 * the onboarding + settings HTML. `resolveModel` is the single precedence rule.
 */

import type { AgentProvider } from '../manifest/types.js';

export interface ModelOption {
  /** The `--model` value passed to the agent CLI. */
  id: string;
  /** Human label for the picker. */
  label: string;
  /** Agent CLIs that accept this exact model id. */
  providers: readonly AgentProvider[];
}

/**
 * Offered models, newest/most-capable first. Ids are the exact CLI `--model`
 * values. Keep in sync with the mirrored lists in the onboarding + settings
 * webview HTML (they can't import this module).
 */
export const KNOWN_MODELS: readonly ModelOption[] = [
  { id: 'claude-opus-4-8', label: 'Opus 4.8', providers: ['claude'] },
  { id: 'claude-sonnet-5', label: 'Sonnet 5', providers: ['claude'] },
  { id: 'claude-haiku-4-5', label: 'Haiku 4.5', providers: ['claude'] },
  { id: 'claude-fable-5', label: 'Fable 5', providers: ['claude'] },
  { id: 'gemini-3.6-flash-high', label: 'Gemini 3.6 Flash (High)', providers: ['antigravity'] },
  { id: 'gemini-3.6-flash-medium', label: 'Gemini 3.6 Flash (Medium)', providers: ['antigravity'] },
  { id: 'gemini-3.6-flash-low', label: 'Gemini 3.6 Flash (Low)', providers: ['antigravity'] },
  { id: 'gemini-3.5-flash-high', label: 'Gemini 3.5 Flash (High)', providers: ['antigravity'] },
  { id: 'gemini-3.5-flash-medium', label: 'Gemini 3.5 Flash (Medium)', providers: ['antigravity'] },
  { id: 'gemini-3.5-flash-low', label: 'Gemini 3.5 Flash (Low)', providers: ['antigravity'] },
  { id: 'gemini-3.1-pro-high', label: 'Gemini 3.1 Pro (High)', providers: ['antigravity'] },
  { id: 'gemini-3.1-pro-low', label: 'Gemini 3.1 Pro (Low)', providers: ['antigravity'] },
  { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', providers: ['antigravity'] },
  { id: 'claude-opus-4-6-thinking', label: 'Claude Opus 4.6 Thinking', providers: ['antigravity'] },
  { id: 'gpt-oss-120b-medium', label: 'GPT-OSS 120B (Medium)', providers: ['antigravity'] },
] as const;

export function modelsForProvider(provider: AgentProvider): readonly ModelOption[] {
  return KNOWN_MODELS.filter((model) => model.providers.includes(provider));
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

function isCompatibleKnownModel(provider: AgentProvider, id: string): boolean {
  const known = KNOWN_MODELS.find((model) => model.id === id);
  return known === undefined || known.providers.includes(provider);
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
): string | undefined {
  for (const candidate of [ticketModel, defaultModel]) {
    const id = firstNonBlank(candidate);
    if (id && isCompatibleKnownModel(provider, id)) return id;
  }
  return undefined;
}
