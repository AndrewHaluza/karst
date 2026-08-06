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
