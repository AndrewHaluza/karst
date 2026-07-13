import type { AgentProvider } from '../manifest/types.js';
import type { AgentAdapter } from './adapter.js';
import { ClaudeAdapter } from './claude.js';

/** Providers with a working adapter today. Used to gate the settings UI. */
export const IMPLEMENTED_PROVIDERS: readonly AgentProvider[] = ['claude'];

const FACTORIES: Partial<Record<AgentProvider, () => AgentAdapter>> = {
  claude: () => new ClaudeAdapter(),
};

/**
 * Resolve the adapter for a provider. Only 'claude' is implemented (MVP);
 * any other/unimplemented provider falls back to ClaudeAdapter so the tool
 * stays usable — provider selection persists but non-claude is inert until
 * its adapter lands.
 */
export function resolveAdapter(provider: AgentProvider): AgentAdapter {
  const factory = FACTORIES[provider] ?? FACTORIES.claude!;
  return factory();
}
