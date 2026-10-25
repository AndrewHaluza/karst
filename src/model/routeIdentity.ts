/**
 * Route/gateway brand identity — single source of truth for how a multi-provider
 * model ROUTE renders in the shared agent picker: its canonical name, its
 * subscription badge (OpenCode Zen 'Z', OpenCode Go 'Go'), and its inline SVG
 * mark.
 *
 * A route is the first segment of a model id: `opencode/<m>` (Zen),
 * `opencode-go/<m>` (Go), `openrouter/<vendor>/<m>`. The picker parses the id
 * and renders whatever this registry supplies; an unregistered route degrades
 * to a letter monogram, never a blank hole.
 *
 * The marks are the same Lobe Icons monochrome SVGs as the agent-core marks
 * (`model/icons/agent/`), vendored next to this module and mirrored into
 * `dist/model/icons/route/` by `scripts/copy-assets.mjs`. `ui:ICONS-05` item 4
 * records route logos (and the letter-monogram fallback) as an approved
 * identity-mark exception class.
 *
 * Host-only: this module reads files, so it is never imported by a webview
 * bundle. A webview receives the emitted `AP_ROUTES` page global instead (the
 * settings React app reads it through `ui/settings/app/hostBridge.ts`).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RUNTIME_ASSETS_ROOT } from '../runtimeAssetsRoot.js';
import { normalizeSvg } from './agentIdentity.js';

/** One registered model route: display name, icon asset, optional badge. */
export interface RouteMeta {
  readonly name: string;
  readonly icon: string;
  /** Short subscription marker drawn on the icon's corner ('Z', 'Go'). */
  readonly badge?: string;
}

/** THE route registry. A new gateway = one entry here + one icon file. */
export const ROUTE_META: Readonly<Record<string, RouteMeta>> = {
  opencode: { name: 'OpenCode Zen', icon: 'opencode.svg', badge: 'Z' },
  'opencode-go': { name: 'OpenCode Go', icon: 'opencode.svg', badge: 'Go' },
  openrouter: { name: 'OpenRouter', icon: 'openrouter.svg' },
};

/** Where the route SVGs are read from at runtime (the src tree under vitest, `dist/` shipped). */
export const ROUTE_ICONS_DIR = join(RUNTIME_ASSETS_ROOT, 'model', 'icons', 'route');

const ICON_CACHE: Record<string, string> = {};
let ICONS_LOADED = false;

function loadRouteIcons(): void {
  if (ICONS_LOADED) return;
  for (const [route, meta] of Object.entries(ROUTE_META)) {
    try {
      ICON_CACHE[route] = normalizeSvg(readFileSync(join(ROUTE_ICONS_DIR, meta.icon), 'utf8'));
    } catch {
      // A missing asset degrades to the letter monogram — never a throw that
      // takes the webview down with it.
      ICON_CACHE[route] = '';
    }
  }
  ICONS_LOADED = true;
}

/** The normalized inline SVG for a route; '' for an unknown/unloadable one. */
export function routeIconSvg(route: string): string {
  loadRouteIcons();
  return ICON_CACHE[route] ?? '';
}

/** Route id → inline SVG icon string ('' when the asset is missing). */
export const ROUTE_ICONS: Readonly<Record<string, string>> = Object.fromEntries(
  Object.keys(ROUTE_META).map((route) => [route, routeIconSvg(route)]),
);

/**
 * The routes map every picker host hands to `mountAgentPicker({ routes })`,
 * emitted as a webview global (`var`, so a sibling React bundle can read it off
 * `globalThis`). A missing global means no route icons — the pre-route look.
 */
export function routeIdentityJs(): string {
  const routes = Object.fromEntries(
    Object.entries(ROUTE_META).map(([route, meta]) => [
      route,
      { name: meta.name, badge: meta.badge ?? '', iconSvg: routeIconSvg(route) },
    ]),
  );
  return `var AP_ROUTES = ${JSON.stringify(routes)};`;
}
