/**
 * The single source of truth for per-webview injector chains.
 *
 * Every host that serves a webview (extension.ts, sidebar/host.ts,
 * settings/host.ts, ticketForm/host.ts, gettingStarted/host.ts) and the
 * jsdom render harness both consume this table.  There is one table; there is
 * no second composition to keep in sync.
 *
 * The existing `runInNewContext` VM harnesses (dashboard, diffs, settings
 * webview.test.ts) still compose injectors inline for direct unit assertions
 * on internal functions (esc, fileMatches, …) — a capability the jsdom
 * harness deliberately does not have.  Migrating or deleting them is per-view
 * work in FEAT-37; both harnesses are legitimate and answer different
 * questions.
 *
 * `injectCsp` is NOT part of the chain — it runs at panel-creation time with
 * a fresh nonce, not at hydration time.  `injectXterm` is likewise excluded:
 * it needs on-disk vendor assets and a `warn` seam that belong to the
 * dashboard host only.
 *
 * Order is innermost-first: the leftmost function in the chain receives the
 * raw HTML; each subsequent function receives its predecessor's output.
 */
import { injectDesignSystem } from './designSystem.js';
import { injectPalette } from './palette.js';
import { injectAgentIdentity } from './agentIdentity.js';
import { injectProviderIdentity } from './providerIdentity.js';
import { injectAgentPicker } from './agentPicker.js';

export const WEBVIEW_NAMES = [
  'dashboard',
  'diffs',
  'gettingStarted',
  'resources',
  'settings',
  'sidebar',
  'ticketForm',
  'usage',
] as const;

export type WebviewName = (typeof WEBVIEW_NAMES)[number];

/**
 * Per-view injector chains, innermost first.
 *
 * The functions are stored as arrow wrappers so the record is a plain
 * `Record<WebviewName, ...>` (not callable) — callers index by name, then
 * invoke the returned function.
 */
type Chain = (html: string) => string;

const DS_PALETTE: Chain = (html) => injectPalette(injectDesignSystem(html));

const DS_PALETTE_PROVIDER_AGENT_PICKER: Chain = (html) =>
  injectAgentPicker(
    injectAgentIdentity(injectProviderIdentity(injectPalette(injectDesignSystem(html)))),
  );

const DS_AGENT_PALETTE: Chain = (html) =>
  injectPalette(injectAgentIdentity(injectDesignSystem(html)));

export const WEBVIEW_CHAINS: Record<WebviewName, Chain> = {
  dashboard: DS_PALETTE_PROVIDER_AGENT_PICKER,
  settings: DS_PALETTE_PROVIDER_AGENT_PICKER,
  ticketForm: DS_PALETTE_PROVIDER_AGENT_PICKER,
  sidebar: DS_AGENT_PALETTE,
  usage: DS_PALETTE,
  resources: DS_PALETTE,
  diffs: DS_PALETTE,
  gettingStarted: DS_PALETTE,
};

/**
 * Hydrate a webview's raw HTML through its injector chain.
 *
 * Throws if `name` is not a known webview.  Pure: the input string is
 * unmodified and identical inputs always produce identical outputs.
 */
export function hydrateWebview(name: WebviewName, html: string): string {
  const chain = WEBVIEW_CHAINS[name];
  if (!chain) {
    throw new Error(`Unknown webview name: ${name}`);
  }
  return chain(html);
}
