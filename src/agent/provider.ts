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
  'opencode2',
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
 * adapter tests — codex/opencode bridges emit UsageUpdate; claude's interactive
 * usage is read from its session transcript (claudeTranscriptWatch.ts);
 * antigravity's interactive usage is read from its conversation DB
 * (agyUsageWatch.ts); every implemented provider is now measured.
 */
export interface ProviderCapabilityResult {
  provider: AgentProvider;
  /** True only when the provider's sessions produce measured token counts. */
  interactiveUsage: boolean;
}

export const PROVIDER_INTERACTIVE_USAGE: Readonly<Record<AgentProvider, boolean>> = {
  claude: true,
  codex: true,
  antigravity: true,
  opencode: true,
  // opencode2's hook bridge posts cumulative `session.usage.updated` tallies,
  // so a live session is measured exactly like v1's.
  opencode2: true,
};

/** The typed capability result for one provider. */
export function providerInteractiveUsage(provider: AgentProvider): ProviderCapabilityResult {
  return { provider, interactiveUsage: PROVIDER_INTERACTIVE_USAGE[provider] };
}

/**
 * Whether an interactive launch on this provider emits a `SessionStart` that can
 * CONFIRM its prepared launch intent (`session_launch_intents.status`). This is
 * the per-core fact the launch-delivery guard (v68) reads before it accuses a
 * launch of never starting: a core with no confirmation path would otherwise be
 * re-delivered a duplicate brief and then flagged `not-started` forever, because
 * nothing it does can ever move its pending intent.
 *
 *  - claude / codex / opencode — the installed hook channel posts SessionStart;
 *  - antigravity — the conversation-DB watch synthesizes SessionStart
 *    (`agyWatchLoop.ts`, ~10s poll);
 *  - opencode2 — no hook bridge yet (its own ticket), so its launches are
 *    EXEMPT: the guard never acts on them.
 *
 * Kept beside `PROVIDER_INTERACTIVE_USAGE` for the same reason: it is a pure
 * provider fact a vscode-free consumer must read without importing the adapters.
 */
export const PROVIDER_CONFIRMS_LAUNCH: Readonly<Record<AgentProvider, boolean>> = {
  claude: true,
  codex: true,
  antigravity: true,
  opencode: true,
  // No SessionStart source exists for opencode2 yet, so its prepared launch can
  // never confirm — the guard must not treat that as "never started".
  opencode2: false,
};

/** Whether the provider's launches can confirm their prepared intent. */
export function providerConfirmsLaunch(provider: AgentProvider): boolean {
  return PROVIDER_CONFIRMS_LAUNCH[provider];
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
