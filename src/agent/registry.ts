import type { AgentProvider } from '../manifest/types.js';
import { isKnownProvider } from './provider.js';
import { DEFAULT_SUBMIT_DELAY_MS, type AgentAdapter } from './adapter.js';
import { ClaudeAdapter } from './claude.js';
import { AntigravityAdapter } from './antigravity.js';
import { CodexAdapter } from './codex.js';
import { OpencodeAdapter } from './opencode.js';
import { Opencode2Adapter } from './opencode2.js';
import { withHeadlessLedger } from './accounts/headlessLedger.js';
import { FAKE_CORE_ENV, FAKE_CORE_SCRIPT_ENV, FakeAdapter } from './fakeCore.js';
import { recordFakeCoreHit } from './fakeCoreLedger.js';
import { loadFakeCoreScript } from '../uatHost/fakeCoreScript.js';
import { STUB_AGENT_ENV, wrapLaunchStub } from './launchStub.js';

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

let fakeCoreWarned = false;
// No injected debug seam exists in this module, so a single console.warn per process.
function warnFakeCoreOnce(mode: string): void {
  if (fakeCoreWarned) return;
  fakeCoreWarned = true;
  console.warn(`karst: ${FAKE_CORE_ENV}=${mode}, fake agent core is active (no real agent runs).`);
}

// Callers resolve an adapter per call, so a scripted core must outlive one resolve to count its answers.
let scripted: { path: string; adapter: FakeAdapter } | undefined;

function fakeAdapter(): FakeAdapter {
  const path = process.env[FAKE_CORE_SCRIPT_ENV];
  if (!path) return new FakeAdapter();
  if (scripted?.path === path) return scripted.adapter;
  let script;
  try {
    script = loadFakeCoreScript(path);
  } catch (err) {
    throw new Error(`${FAKE_CORE_SCRIPT_ENV}: cannot use ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
  const adapter = new FakeAdapter(script, recordFakeCoreHit);
  scripted = { path, adapter };
  return adapter;
}

/**
 * Resolve the adapter for a validated provider.
 */
export function resolveAdapter(provider: AgentProvider): AgentAdapter {
  const mode = process.env[FAKE_CORE_ENV];
  if (mode === '1') {
    warnFakeCoreOnce(mode);
    return fakeAdapter();
  }
  const stub = process.env[STUB_AGENT_ENV];
  if (mode === 'launch' && stub) {
    warnFakeCoreOnce(mode);
    return wrapLaunchStub(provider, FACTORIES[provider](), stub);
  }
  return withHeadlessLedger(provider, FACTORIES[provider]());
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
