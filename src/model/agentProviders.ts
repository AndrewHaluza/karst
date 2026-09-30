/**
 * Browser-safe home of the agent-core registry.
 *
 * The settings React app needs `AGENT_PROVIDERS` and `AGENT_PROVIDER_LABELS` to
 * offer the `agentProvider` / `defaultModel` / `defaultEffort` choice, and it
 * cannot import them from `agentIdentity.js`: that module reads the core SVG
 * assets off disk with `node:fs`, which is host-only and cannot be bundled into
 * a webview asset. So the registry lives here, dependency-free, and
 * `agentIdentity.ts` re-exports it — one definition, two importers, and no
 * mirrored literal in the webview (UI-R34 / NDL-126 R-X1, "import, never
 * mirror"). This is the same split `startDefaults.ts` makes for
 * `DEFAULT_START_STATUS`.
 *
 * The ICON PATHS stay in `agentIdentity.ts`: they are host-side file reads, and
 * only the host resolves them. This module owns the vocabulary (which cores
 * exist, and what each is called) and nothing else — a new provider is one entry
 * here plus one file under `model/icons/agent/`, keyed by `AgentProvider` so a
 * provider can never be registered in one surface and missing from another.
 *
 * This module must stay dependency-free: it is imported from the settings
 * bundle, so anything it pulls in ends up there too.
 */
import type { AgentProvider } from '../manifest/types.js';

/** One registered agent core: its canonical display name + icon asset. */
export interface AgentCoreMeta {
  /** Canonical provider name (e.g. "Claude Code"). */
  label: string;
  /** Canonical SVG asset file under `model/icons/agent/`. */
  icon: string;
}

/** THE agent-core registry. A new provider = one entry here + one icon file. */
export const AGENT_PROVIDERS: Readonly<Record<AgentProvider, AgentCoreMeta>> = {
  claude: { label: 'Claude Code', icon: 'claude-code.svg' },
  codex: { label: 'Codex', icon: 'codex.svg' },
  antigravity: { label: 'Antigravity CLI', icon: 'antigravity-cli.svg' },
  opencode: { label: 'OpenCode', icon: 'opencode.svg' },
};

/** Agent provider id → display label, derived from the registry. */
export const AGENT_PROVIDER_LABELS: Readonly<Record<AgentProvider, string>> = Object.fromEntries(
  Object.entries(AGENT_PROVIDERS).map(([provider, meta]) => [provider, meta.label]),
) as Record<AgentProvider, string>;

/**
 * Every core id, in registry order. The settings picker offers these and marks
 * the ones `agent/registry.ts` has not implemented as unavailable, so this is
 * the "known" vocabulary rather than the "working" one.
 */
export const KNOWN_AGENT_PROVIDERS: readonly AgentProvider[] = Object.keys(
  AGENT_PROVIDERS,
) as AgentProvider[];
