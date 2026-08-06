import type { AgentProvider } from '../manifest/types.js';
import type { AgentAdapter } from './adapter.js';
import { ClaudeAdapter } from './claude.js';
import { AntigravityAdapter } from './antigravity.js';
import { CodexAdapter } from './codex.js';
import { OpencodeAdapter } from './opencode.js';

// Pure provider facts live in `provider.ts` so read-only consumers can use the
// precedence rule without importing the adapters (and their process spawns).
export {
  IMPLEMENTED_PROVIDERS,
  isKnownProvider,
  resolveProvider,
} from './provider.js';

const FACTORIES: Record<AgentProvider, () => AgentAdapter> = {
  claude: () => new ClaudeAdapter(),
  codex: () => new CodexAdapter(),
  antigravity: () => new AntigravityAdapter(),
  opencode: () => new OpencodeAdapter(),
};

/**
 * Resolve the adapter for a validated provider.
 */
export function resolveAdapter(provider: AgentProvider): AgentAdapter {
  return FACTORIES[provider]();
}
