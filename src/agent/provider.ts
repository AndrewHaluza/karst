import type { AgentProvider } from '../manifest/types.js';

/**
 * Pure provider facts, deliberately separate from `registry.ts`.
 *
 * `registry.ts` constructs launch adapters, so importing it drags
 * `node:child_process` and the hook-settings writer into whatever imports it.
 * Read-only consumers (diagnostics collection) need the precedence rule but
 * must not be able to reach a process spawn — guarded by
 * `diagnostics/nonInterference.test.ts`.
 */

/** Providers with a working adapter today. Used to gate the settings UI. */
export const IMPLEMENTED_PROVIDERS: readonly AgentProvider[] = [
  'claude',
  'codex',
  'antigravity',
  'opencode',
];

/** Type guard for a value that is a known, implemented agent provider. */
export function isKnownProvider(value: unknown): value is AgentProvider {
  return typeof value === 'string' && (IMPLEMENTED_PROVIDERS as readonly string[]).includes(value);
}

/**
 * A typed per-provider capability result (Task 5).
 *
 * The adapters each DECLARE the capability on their `AgentCapabilities`
 * (optional there, because pre-Task-5 surfaces construct adapters without it);
 * reducers that must distinguish "this provider is not measured" from "the
 * provider measured a zero" read THIS map instead of an adapter — a zero
 * invented from an unmeasured provider would read as a measured free call.
 *
 * The map is a pure fact table, deliberately kept out of `registry.ts`: it must
 * stay importable by read-only consumers (the same constraint that keeps
 * `provider.ts` free of `node:child_process`). The truth is pinned in the
 * adapter tests — codex/opencode bridges emit UsageUpdate, claude/antigravity
 * have no token-bearing lifecycle channel.
 */
export interface ProviderCapabilityResult {
  provider: AgentProvider;
  /** True only when the provider's bridge can emit measured UsageUpdate events. */
  interactiveUsage: boolean;
}

export const PROVIDER_INTERACTIVE_USAGE: Readonly<Record<AgentProvider, boolean>> = {
  claude: false,
  codex: true,
  antigravity: false,
  opencode: true,
};

/** The typed capability result for one provider. */
export function providerInteractiveUsage(provider: AgentProvider): ProviderCapabilityResult {
  return { provider, interactiveUsage: PROVIDER_INTERACTIVE_USAGE[provider] };
}

/**
 * Resolve the effective agent provider (§ agent core selection): the
 * ticket's own override wins, else the manifest default, else `'claude'`.
 * Mirrors `resolveModel`'s precedence in `agent/models.ts`.
 */
export function resolveProvider(
  ticketProvider: AgentProvider | null | undefined,
  manifestProvider: AgentProvider | null | undefined,
): AgentProvider {
  return ticketProvider ?? manifestProvider ?? 'claude';
}
