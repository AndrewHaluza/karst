/**
 * The curated set of launch models offered per-ticket and as the manifest
 * default (§ model selection). vscode-free so it is unit-testable and shared by
 * the store, the launch path, and (mirrored, since a webview can't import TS)
 * the onboarding + settings HTML. `resolveModel` is the single precedence rule.
 */

export interface ModelOption {
  /** The `--model` value passed to the agent CLI. */
  id: string;
  /** Human label for the picker. */
  label: string;
}

/**
 * Offered models, newest/most-capable first. Ids are the exact CLI `--model`
 * values. Keep in sync with the mirrored lists in the onboarding + settings
 * webview HTML (they can't import this module).
 */
export const KNOWN_MODELS: readonly ModelOption[] = [
  { id: 'claude-opus-4-8', label: 'Opus 4.8' },
  { id: 'claude-sonnet-5', label: 'Sonnet 5' },
  { id: 'claude-haiku-4-5', label: 'Haiku 4.5' },
  { id: 'claude-fable-5', label: 'Fable 5' },
] as const;

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
