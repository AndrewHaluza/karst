import type { AgentProvider } from '../manifest/types.js';
import type { AgentAdapter } from './adapter.js';
import { ClaudeAdapter } from './claude.js';
import { AntigravityAdapter } from './antigravity.js';
import { CodexAdapter } from './codex.js';

/** Providers with a working adapter today. Used to gate the settings UI. */
export const IMPLEMENTED_PROVIDERS: readonly AgentProvider[] = [
  'claude',
  'codex',
  'antigravity',
];

const FACTORIES: Record<AgentProvider, () => AgentAdapter> = {
  claude: () => new ClaudeAdapter(),
  codex: () => new CodexAdapter(),
  antigravity: () => new AntigravityAdapter(),
};

/**
 * Resolve the adapter for a validated provider.
 */
export function resolveAdapter(provider: AgentProvider): AgentAdapter {
  return FACTORIES[provider]();
}
