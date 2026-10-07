import type { AgentProvider } from '../manifest/types.js';
import { isKnownProvider } from './provider.js';
import { DEFAULT_SUBMIT_DELAY_MS, type AgentAdapter } from './adapter.js';
import { ClaudeAdapter } from './claude.js';
import { AntigravityAdapter } from './antigravity.js';
import { CodexAdapter } from './codex.js';
import { OpencodeAdapter } from './opencode.js';
import { Opencode2Adapter } from './opencode2.js';

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
  opencode2: () => new Opencode2Adapter(),
};

/**
 * Resolve the adapter for a validated provider.
 */
export function resolveAdapter(provider: AgentProvider): AgentAdapter {
  return FACTORIES[provider]();
}

/**
 * The measured typed-submit delay for a provider, or the shared last-resort
 * default when the provider is unknown. Used to deliver a nudge into a session
 * this window did NOT launch (a revived handle), where no adapter instance is
 * on hand — real launches carry their own adapter's `submitDelayMs`.
 */
export function submitDelayFor(provider: string | undefined): number {
  return isKnownProvider(provider)
    ? (resolveAdapter(provider).capabilities.submitDelayMs ?? DEFAULT_SUBMIT_DELAY_MS)
    : DEFAULT_SUBMIT_DELAY_MS;
}
