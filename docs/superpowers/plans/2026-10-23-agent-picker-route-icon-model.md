# Agent Picker: Route Icon + Model Stack Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The shared agent picker shows a multi-provider model id readably — route as an icon, model name on line 1, gateway vendor on line 2, a `free` tag that never shrinks — and its menu is grouped route → vendor with a full-id footer.

**Architecture:** A pure id parser and the grouping/trigger builders live in the vanilla runtime `src/model/agentPicker.webview.js` (evaluated as file text by `agentPicker.test.ts`). Route identity (name, badge, Lobe SVG) is a new host module `src/model/routeIdentity.ts` mirroring `agentIdentity.ts`, emitted into every picker document as the `AP_ROUTES` global and handed to `mountAgentPicker` through a new optional `routes` option. A missing `routes` map is today's behaviour.

**Tech Stack:** TypeScript (ESM, `.js` import suffixes), vanilla webview JS/CSS read verbatim at runtime, design tokens (`--k-*`), vitest (unit), Playwright (layout + visual).

**Spec:** ticket `AGENT-PICKER-ROUTE-ICON-MODEL` (T777) — the spilled description at
`~/Library/Application Support/Cursor/User/globalStorage/karst.karst/attachments/777/222acc7ecdae3efa.txt`
(steps 1–8 are the behaviour spec; the linked prototype `https://claude.ai/artifact/8d7fhSuGCqrhTZJhGUdiqN`
could not be opened from this session — user approved implementing from the step text).

## Global Constraints

- **Approved rule readings (user, 2026-10-23):**
  1. `ui:ICONS-05` gains **item 4**: route/gateway brand logos (`src/model/routeIdentity.ts` — OpenRouter, OpenCode Zen/Go) are a documented identity-mark exception class.
  2. The unknown-route **monogram** (first letter, hue derived from the route id, `aria-hidden`) is approved and documented in that same item — it is a generated placeholder, not an invented icon concept.
  3. `ui:UI-R44` is satisfied for truncated model text by the **menu footer** (visible, `aria-live="polite"`, driven by ↑↓) plus each row's `title`. An `aria-label` alone is still never enough.
  4. **Step 7 (catalog `free`/`vendor` fields) is dropped**: the parser is the only source. No `ModelOption` change, no catalog mirror, no catalog-skill pass.
- Never edit `docs/ui/UI-RULES.md`, baselines (`tests/visual/__baselines__/**`) or the layout ledger to pass a gate. Baseline changes need user approval (ticket "Done when").
- `src/model/**` is outside the Stryker `mutate` globs (`src/extension/**`), so the mutation gate does not cover this change.
- Picker JS/CSS are real sibling source files read with `readFileSync(join(RUNTIME_ASSETS_ROOT, …))`; `scripts/copy-assets.mjs` must list every new runtime asset. Edit the SOURCE, never `dist/`.
- `agentPicker.webview.js` is never bundled — its correctness is held by evaluating **that file's text** in `src/model/agentPicker.test.ts`. No TS twin.
- All four picker hosts must work: Settings Agents (RolesTab/RoleRows), Settings Approaches, the ticket form, and the dashboard switch.
- Unit run for one file: `npx vitest run src/model/agentPicker.test.ts` (rebuild ABI first with `npm run -s rebuild:node` if it has not been built).
- Every commit is conventional (`feat:`/`test:`/`docs:`) and cites the rule id it satisfies (UI-R35).

---

### Task 1: Route identity host module

**Files:**
- Create: `src/model/routeIdentity.ts`
- Create: `src/model/routeIdentity.test.ts`
- Create: `src/model/icons/route/openrouter.svg`
- Create: `src/model/icons/route/opencode.svg`
- Modify: `src/model/agentIdentity.ts` (export `normalizeSvg`)
- Modify: `scripts/copy-assets.mjs` (carry both route SVGs)

**Interfaces:**
- Consumes: `normalizeSvg(raw: string): string` (now exported from `agentIdentity.ts`), `RUNTIME_ASSETS_ROOT`.
- Produces: `ROUTE_META: Readonly<Record<string, RouteMeta>>` with `RouteMeta = { name: string; icon: string; badge?: string }`; `ROUTE_ICONS_DIR: string`; `routeIconSvg(route: string): string`; `ROUTE_ICONS: Readonly<Record<string, string>>`; `routeIdentityJs(): string` emitting `var AP_ROUTES = {…}`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ROUTE_META,
  ROUTE_ICONS,
  ROUTE_ICONS_DIR,
  routeIconSvg,
  routeIdentityJs,
} from './routeIdentity.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ICONS = join(HERE, 'icons', 'route');

describe('ROUTE_META', () => {
  it('names the three known routes', () => {
    expect(ROUTE_META.opencode.name).toBe('OpenCode Zen');
    expect(ROUTE_META['opencode-go'].name).toBe('OpenCode Go');
    expect(ROUTE_META.openrouter.name).toBe('OpenRouter');
  });

  it('badges the two OpenCode subscriptions and nothing else', () => {
    expect(ROUTE_META.opencode.badge).toBe('Z');
    expect(ROUTE_META['opencode-go'].badge).toBe('Go');
    expect(ROUTE_META.openrouter.badge).toBeUndefined();
  });

  it('every registered icon asset exists', () => {
    for (const meta of Object.values(ROUTE_META)) {
      expect(existsSync(join(ICONS, meta.icon)), meta.icon).toBe(true);
    }
  });

  it('every icon is monochrome — currentColor, no baked colour or paint server', () => {
    for (const [route, meta] of Object.entries(ROUTE_META)) {
      const raw = readFileSync(join(ICONS, meta.icon), 'utf8');
      expect(raw, route).toMatch(/fill="currentColor"/);
      expect(raw, route).not.toMatch(/fill="#/);
      expect(raw, route).not.toMatch(/<(mask|filter|linearGradient|radialGradient)/i);
    }
  });

  it('loads a normalized inline SVG (no width/height/style/title, no inter-tag space)', () => {
    const svg = routeIconSvg('openrouter');
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg).not.toMatch(/width="1em"/);
    expect(svg).not.toMatch(/height="1em"/);
    expect(svg).not.toMatch(/<title>/);
    expect(svg).not.toMatch(/>\s+</);
  });

  it('returns empty for an unknown route (the picker then draws a monogram)', () => {
    expect(routeIconSvg('nope')).toBe('');
  });

  it('resolves the icon directory off the runtime assets root', () => {
    expect(ROUTE_ICONS_DIR.endsWith(join('model', 'icons', 'route'))).toBe(true);
    expect(ROUTE_ICONS.openrouter).toContain('<svg');
  });
});

describe('routeIdentityJs', () => {
  it('emits the AP_ROUTES global the picker option reads', () => {
    const js = routeIdentityJs();
    expect(js.startsWith('var AP_ROUTES = ')).toBe(true);
    const map = JSON.parse(js.slice('var AP_ROUTES = '.length).replace(/;$/, ''));
    expect(Object.keys(map).sort()).toEqual(['opencode', 'opencode-go', 'openrouter']);
    expect(map['opencode-go']).toEqual({
      name: 'OpenCode Go',
      badge: 'Go',
      iconSvg: routeIconSvg('opencode-go'),
    });
    expect(map.openrouter.badge).toBe('');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/model/routeIdentity.test.ts`
Expected: FAIL — `Failed to resolve import "./routeIdentity.js"`.

- [ ] **Step 3: Add the icon assets**

```bash
curl -sSL -o src/model/icons/route/openrouter.svg \
  "https://unpkg.com/@lobehub/icons-static-svg@1.98.0/icons/openrouter.svg"
cp src/model/icons/agent/opencode.svg src/model/icons/route/opencode.svg
```

`openrouter.svg` must be the Lobe Icons monochrome mark (24-viewBox, `fill="currentColor"`, one `<path>`), same source family and licence as the agent-core icons. Neither the agent icons nor Lobe are listed in `THIRD_PARTY_NOTICES.md`, so no notice entry is added (verify with `grep -i lobe THIRD_PARTY_NOTICES.md` → empty).

- [ ] **Step 4: Export `normalizeSvg` from `agentIdentity.ts`**

Change the declaration only (behaviour untouched):

```ts
export function normalizeSvg(raw: string): string {
```

- [ ] **Step 5: Write `src/model/routeIdentity.ts`**

```ts
/**
 * Route/gateway brand identity — single source of truth for how a multi-provider
 * model ROUTE renders in the shared agent picker: its canonical name, its
 * subscription badge (OpenCode Zen 'Z', OpenCode Go 'Go'), and its inline SVG
 * mark.
 *
 * A route is the first segment of a model id: `opencode/<m>` (Zen),
 * `opencode-go/<m>` (Go), `openrouter/<vendor>/<m>`. The picker parses the id and
 * renders whatever this registry supplies; an unregistered route degrades to a
 * letter monogram, never a blank hole.
 *
 * The marks are the same Lobe Icons monochrome SVGs as the agent-core marks
 * (`model/icons/agent/`), vendored next to this module and mirrored into
 * `dist/model/icons/route/` by `scripts/copy-assets.mjs`. `ui:ICONS-05` item 4
 * records route logos as an approved identity-mark exception class.
 *
 * Host-only: this module reads files, so it is never imported by a webview
 * bundle. The settings React app reads the emitted `AP_ROUTES` page global
 * instead (see `ui/settings/app/hostBridge.ts`).
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

/** Where the route SVGs are read from at runtime (src tree under vitest, `dist/` shipped). */
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
 * emitted as a webview global (`var` so a sibling React bundle can read it off
 * `globalThis`). A missing global means no route icons — the pre-change look.
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
```

- [ ] **Step 6: Carry the assets into `dist/`**

In `scripts/copy-assets.mjs`, after the four `model/icons/agent/*.svg` entries:

```js
  'model/icons/route/opencode.svg',
  'model/icons/route/openrouter.svg',
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `npx vitest run src/model/routeIdentity.test.ts src/model/agentIdentity.test.ts`
Expected: PASS (both files).

- [ ] **Step 8: Commit**

```bash
git add src/model/routeIdentity.ts src/model/routeIdentity.test.ts \
  src/model/icons/route src/model/agentIdentity.ts scripts/copy-assets.mjs
git commit -m "feat(picker): route identity registry with Lobe route marks (ui:ICONS-05)"
```

---

### Task 2: Pure model-id parser

**Files:**
- Modify: `src/model/agentPicker.webview.js` (add `apParseModelId`)
- Modify: `src/model/agentPicker.ts` (`agentPickerJs()` prefixes `routeIdentityJs()`)
- Test: `src/model/agentPicker.test.ts`

**Interfaces:**
- Consumes: `routeIdentityJs()` from Task 1.
- Produces: `apParseModelId(id, label) → { id, route, vendor, model, free, variant }`; the picker text now begins with `var AP_ROUTES = …`.

- [ ] **Step 1: Write the failing test**

Append to `src/model/agentPicker.test.ts` (and extend the `load()` return map with `apParseModelId`):

```ts
describe('apParseModelId', () => {
  const { apParseModelId } = load() as {
    apParseModelId: (id: string, label?: string) => {
      id: string; route: string; vendor: string; model: string; free: boolean; variant: string;
    };
  };

  it('leaves an id with no slash unrouted, exactly as today', () => {
    expect(apParseModelId('claude-opus-5', 'Opus 5')).toEqual({
      id: 'claude-opus-5', route: '', vendor: '', model: 'Opus 5', free: false, variant: '',
    });
  });

  it('splits a two-segment id into route and model', () => {
    expect(apParseModelId('opencode/big-pickle', 'big-pickle')).toEqual({
      id: 'opencode/big-pickle', route: 'opencode', vendor: '', model: 'big-pickle', free: false, variant: '',
    });
  });

  it('keeps the middle segment as the vendor', () => {
    expect(apParseModelId('openrouter/mancer/weaver', 'weaver')).toEqual({
      id: 'openrouter/mancer/weaver', route: 'openrouter', vendor: 'mancer', model: 'weaver', free: false, variant: '',
    });
  });

  it('joins a multi-segment vendor path', () => {
    expect(apParseModelId('openrouter/inference-net/schematron-v2-turbo', '').vendor)
      .toBe('inference-net');
    expect(apParseModelId('openrouter/a/b/c/model', '').vendor).toBe('a/b/c');
    expect(apParseModelId('openrouter/a/b/c/model', '').model).toBe('model');
  });

  it('reads :free as the free flag, not as part of the name', () => {
    const p = apParseModelId('openrouter/liquid/lfm-2.5-2.6b:free', '');
    expect(p.model).toBe('lfm-2.5-2.6b');
    expect(p.free).toBe(true);
    expect(p.variant).toBe('');
  });

  it('reads a -free suffix as the free flag', () => {
    const p = apParseModelId('opencode/big-pickle-free', '');
    expect(p.free).toBe(true);
    expect(p.model).toBe('big-pickle-free');
  });

  it('reads #high as the variant', () => {
    const p = apParseModelId('opencode-go/space-bunny#high', '');
    expect(p.route).toBe('opencode-go');
    expect(p.model).toBe('space-bunny');
    expect(p.variant).toBe('high');
    expect(p.free).toBe(false);
  });

  it('reads a non-free colon suffix as the variant', () => {
    const p = apParseModelId('openrouter/x/y:nitro', '');
    expect(p.model).toBe('y');
    expect(p.variant).toBe('nitro');
    expect(p.free).toBe(false);
  });

  it('tolerates empty segments', () => {
    expect(apParseModelId('a//b', '')).toEqual({
      id: 'a//b', route: 'a', vendor: '', model: 'b', free: false, variant: '',
    });
  });

  it('lets a curated label that differs from the id win as the model name', () => {
    expect(apParseModelId('opencode-go/deepseek-v4.1-flash', 'DeepSeek v4.1 Flash').model)
      .toBe('DeepSeek v4.1 Flash');
    expect(apParseModelId('opencode-go/deepseek-v4.1-flash', 'opencode-go/deepseek-v4.1-flash').model)
      .toBe('deepseek-v4.1-flash');
  });

  it('handles empty input without throwing', () => {
    expect(apParseModelId('', '')).toEqual({
      id: '', route: '', vendor: '', model: '', free: false, variant: '',
    });
  });
});

describe('the picker carries the route map', () => {
  it('defines AP_ROUTES inside the emitted picker runtime', () => {
    expect(js).toContain('var AP_ROUTES = ');
    const load = new Function(`${js}\nreturn AP_ROUTES;`)() as Record<string, { name: string }>;
    expect(load.openrouter.name).toBe('OpenRouter');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/model/agentPicker.test.ts`
Expected: FAIL — `apParseModelId` is not defined / `AP_ROUTES` assertions fail.

- [ ] **Step 3: Implement the parser**

Insert after `apTags` in `src/model/agentPicker.webview.js`:

```js
// ── model id parsing (design § model menu: routes, vendors, free) ────────────
/**
 * Split a model id into the parts the picker renders (pure, no DOM):
 * `opencode/<m>` → route `opencode`; `openrouter/<vendor>/<m>` → route +
 * vendor; a `#variant` or `:variant` suffix → variant; `:free`/`-free` → free.
 * A curated catalog label that is more than the raw id wins as the model name.
 */
function apParseModelId(id, label) {
  var raw = String(id === null || id === undefined ? '' : id);
  var seg = raw.split('/');
  var out;
  if (seg.length < 2) {
    out = { id: id, route: '', vendor: '', model: label || id || '', free: false, variant: '' };
  } else {
    var last = seg[seg.length - 1];
    var variant = '';
    var free = false;
    var h = last.indexOf('#');
    if (h >= 0) { variant = last.slice(h + 1); last = last.slice(0, h); }
    var c = last.indexOf(':');
    if (c >= 0) {
      var suf = last.slice(c + 1);
      last = last.slice(0, c);
      if (suf === 'free') free = true; else variant = suf;
    }
    if (/-free$/.test(last)) free = true;
    out = {
      id: id, route: seg[0], vendor: seg.slice(1, -1).join('/'),
      model: last, free: free, variant: variant,
    };
  }
  if (label && label !== id) out.model = label;
  return out;
}
```

- [ ] **Step 4: Prefix the emitted runtime in `agentPicker.ts`**

```ts
import { routeIdentityJs } from './routeIdentity.js';
...
export function agentPickerJs(): string {
  // The route identity map travels INSIDE the picker blob so every picker host
  // (settings, ticket form, dashboard) has `AP_ROUTES` in script scope without a
  // second injection point; a host that passes no `routes` keeps the old look.
  return `${routeIdentityJs()}\n${readFileSync(join(RUNTIME_ASSETS_ROOT, 'model/agentPicker.webview.js'), 'utf8').trim()}`;
}
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run src/model/agentPicker.test.ts`
Expected: PASS (parser cases + route map; earlier suites still green).

- [ ] **Step 6: Commit**

```bash
git add src/model/agentPicker.webview.js src/model/agentPicker.ts src/model/agentPicker.test.ts
git commit -m "feat(picker): parse route, vendor, variant and free from a model id"
```

---

### Task 3: Closed-control stack (route icon, model, vendor, free)

**Files:**
- Modify: `src/model/agentPicker.webview.js` (`apRouteMeta`, `apRouteName`, `apRouteHue`, `apRouteIconHtml`, `apModelStackHtml`, `apRoutedTriggerName`, `renderModel`)
- Modify: `src/model/agentPicker.webview.css`
- Test: `src/model/agentPicker.test.ts`

**Interfaces:**
- Consumes: `apParseModelId` (Task 2); the `routes` option `{ [routeId]: { name, badge?, iconSvg? } }`.
- Produces: trigger markup `.ap-route` / `.ap-route-badge` / `.ap-mono` / `.ap-mstack` / `.ap-mname` / `.ap-mvendor` / `.ap-variant` / `.ap-free`; `apRoutedTriggerName(caption, parsed, routes)`.

- [ ] **Step 1: Write the failing test**

```ts
describe('route identity in the closed control', () => {
  const { apRouteIconHtml, apRoutedTriggerName, apRouteHue } = load() as {
    apRouteIconHtml: (route: string, routes?: unknown) => string;
    apRoutedTriggerName: (caption: string, parsed: unknown, routes?: unknown) => string;
    apRouteHue: (route: string) => number;
  };
  const routes = {
    openrouter: { name: 'OpenRouter', badge: '', iconSvg: '<svg id="or"></svg>' },
    opencode: { name: 'OpenCode Zen', badge: 'Z', iconSvg: '<svg id="oc"></svg>' },
    unknown: { name: '', badge: '', iconSvg: '' },
  };
  const parse = (load() as { apParseModelId: (i: string, l?: string) => unknown }).apParseModelId;

  it('renders the host icon and badge for a known route', () => {
    const out = apRouteIconHtml('opencode', routes);
    expect(out).toContain('class="ap-route"');
    expect(out).toContain('title="OpenCode Zen"');
    expect(out).toContain('<svg id="oc"></svg>');
    expect(out).toContain('class="ap-route-badge">Z<');
    expect(out).toContain('aria-hidden="true"');
  });

  it('falls back to a letter monogram with a derived hue for an unknown route', () => {
    const out = apRouteIconHtml('weaver-net', routes);
    expect(out).toContain('class="ap-mono"');
    expect(out).toContain('>W<');
    expect(out).toMatch(/style="--ap-hue:\d+"/);
    expect(out).toContain('title="weaver-net"');
    expect(out).not.toContain('ap-route-badge');
  });

  it('renders no mark at all for an empty route', () => {
    expect(apRouteIconHtml('', routes)).toBe('');
  });

  it('derives a stable hue per route id', () => {
    expect(apRouteHue('openrouter')).toBe(apRouteHue('openrouter'));
    expect(apRouteHue('openrouter')).toBeGreaterThanOrEqual(0);
    expect(apRouteHue('openrouter')).toBeLessThan(360);
  });

  it('names the trigger with the model, the vendor, the route and the full id', () => {
    expect(apRoutedTriggerName('Model', parse('openrouter/mancer/weaver', 'weaver'), routes))
      .toBe('Model: weaver, mancer via OpenRouter \u2014 openrouter/mancer/weaver');
  });

  it('names a two-segment route without a vendor line, and appends free', () => {
    expect(apRoutedTriggerName('Model', parse('opencode/big-pickle', 'big-pickle'), routes))
      .toBe('Model: big-pickle via OpenCode Zen \u2014 opencode/big-pickle');
    expect(apRoutedTriggerName('Model', parse('openrouter/x/y:free', ''), routes))
      .toContain(', free');
  });

  it('ships the two-line stack, the never-shrinking free tag and the container query', () => {
    expect(js).toContain('ap-mstack');
    expect(js).toContain('ap-mvendor');
    expect(js).toContain('aria-describedby="\' + apEsc(triggerId) + \'"');
    const css = agentPickerCss();
    expect(css).toContain('.ap-mstack{display:flex;flex-direction:column');
    expect(css).toMatch(/\.ap-mname,\.ap-mvendor\{[^}]*text-overflow:ellipsis/);
    expect(css).toMatch(/\.ap-free\{[^}]*flex:none/);
    expect(css).toContain('.ap-shell[data-ap-shell="model"]{container-type:inline-size}');
    expect(css).toContain('@container (max-width: 130px){.ap-free{display:none}}');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/model/agentPicker.test.ts`
Expected: FAIL — builders missing, CSS selectors absent.

- [ ] **Step 3: Implement the builders (after `apParseModelId`)**

```js
/** The host-supplied route meta for a parsed route, or null. */
function apRouteMeta(routes, route) {
  if (!route || !routes || !Object.prototype.hasOwnProperty.call(routes, route)) return null;
  return routes[route] || null;
}

/** The route's display name; the raw id for an unknown route. */
function apRouteName(routes, route) {
  var meta = apRouteMeta(routes, route);
  return meta && meta.name ? meta.name : (route || '');
}

/** Stable hue (0-359) for a route's monogram — same id, same colour, always. */
function apRouteHue(route) {
  var s = String(route || '');
  var h = 0;
  for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
  return h;
}

/**
 * The 16px route mark: the host icon plus its subscription badge, or — for an
 * unknown route, or a known one whose asset is missing — a letter monogram on a
 * hue derived from the id. `ui:ICONS-05` item 4 records both as approved.
 */
function apRouteIconHtml(route, routes) {
  if (!route) return '';
  var meta = apRouteMeta(routes, route);
  var icon = meta && meta.iconSvg ? meta.iconSvg : '';
  var mark = icon || ('<span class="ap-mono">' + apEsc(String(route).charAt(0).toUpperCase()) + '</span>');
  var badge = meta && meta.badge ? '<span class="ap-route-badge">' + apEsc(meta.badge) + '</span>' : '';
  var hue = icon ? '' : ' style="--ap-hue:' + apRouteHue(route) + '"';
  return '<span class="ap-route" title="' + apEsc(apRouteName(routes, route)) + '"' + hue
    + ' aria-hidden="true">' + mark + badge + '</span>';
}

/**
 * The two-line model stack: the model name (with its variant) over the gateway
 * vendor. Both lines clip with an ellipsis and point at the trigger, whose
 * accessible name carries the full text (UI-R44).
 */
function apModelStackHtml(parsed, triggerId) {
  var variant = parsed.variant ? '<span class="ap-variant"> ' + apEsc(parsed.variant) + '</span>' : '';
  var vendor = parsed.vendor
    ? '<span class="ap-mvendor" aria-describedby="' + apEsc(triggerId) + '">' + apEsc(parsed.vendor) + '</span>'
    : '';
  return '<span class="ap-mstack">'
    + '<span class="ap-mname" aria-describedby="' + apEsc(triggerId) + '">'
    + apEsc(parsed.model) + variant + '</span>'
    + vendor
    + '</span>';
}

/** The trigger's accessible name for a routed model: model, vendor, route, full id. */
function apRoutedTriggerName(caption, parsed, routes) {
  var via = ' via ' + apRouteName(routes, parsed.route);
  var who = parsed.vendor ? parsed.model + ', ' + parsed.vendor + via : parsed.model + via;
  return caption + ': ' + who + ' \u2014 ' + parsed.id + (parsed.free ? ', free' : '');
}
```

- [ ] **Step 4: Render the stack in `renderModel()`**

Replace the two `modelTrigger` lines in `renderModel()` with:

```js
    var parsed = apParseModelId(state.model, coreLabel);
    if (parsed.route) {
      modelTrigger.innerHTML = apRouteIconHtml(parsed.route, routes)
        + apModelStackHtml(parsed, apId + '-model')
        + (parsed.free ? '<span class="ap-free">free</span>' : '')
        + '<span class="chev" aria-hidden="true"></span>';
      var stackName = apRoutedTriggerName(labelModel, parsed, routes);
      modelTrigger.title = stackName;
      modelTrigger.setAttribute('aria-label', stackName);
    } else {
      modelTrigger.innerHTML =
        apTriggerLabelHtml(apEsc(coreLabel || labels().model || 'No model (agent picks)'), apId + '-model')
        + '<span class="chev" aria-hidden="true"></span>';
      var triggerName = apModelTriggerName(coreLabel, state.model, labels().model || 'No model (agent picks)');
      modelTrigger.title = triggerName;
      if (compact) modelTrigger.setAttribute('aria-label', labelModel + ': ' + triggerName);
      else modelTrigger.removeAttribute('aria-label');
    }
```

and declare `var routes = o.routes || {};` beside `var catalog`, plus `routes = (next && next.routes) || {};` in `_configure`.

- [ ] **Step 5: Add the CSS**

```css
/* Route + two-line model stack in the closed control (design § model menu).
   The model name and the vendor each clip on one line; the trigger's
   accessible name carries the full id (UI-R44). The `free` tag never shrinks —
   a long model name used to push it out of the control. */
.ap-route{position:relative;flex:none;width:16px;height:16px;display:inline-flex;
  align-items:center;justify-content:center;color:var(--k-text-dim)}
.ap-route svg{width:16px;height:16px;display:block}
.ap-route-badge{position:absolute;right:calc(-1 * var(--k-space-2));bottom:calc(-1 * var(--k-space-2));
  font-size:var(--k-text-2xs);line-height:1;padding:0 var(--k-space-1);border-radius:var(--k-radius-sm);
  background:var(--k-surface);color:var(--k-text-dim);border:var(--k-border-w) solid var(--k-border)}
.ap-mono{width:16px;height:16px;display:inline-flex;align-items:center;justify-content:center;
  border-radius:var(--k-radius-sm);background:hsl(var(--ap-hue,220) 55% 45%);color:var(--k-bg);
  font-size:var(--k-text-2xs);font-weight:600;text-transform:uppercase}
.ap-mstack{display:flex;flex-direction:column;justify-content:center;flex:1 1 auto;min-width:0;line-height:1.2}
.ap-mname,.ap-mvendor{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ap-mvendor{font-size:var(--k-text-2xs);color:var(--k-text-dim)}
.ap-variant{color:var(--k-text-faint);font-size:var(--k-text-2xs)}
.ap-free{flex:none;font-size:var(--k-text-2xs);color:var(--k-success-fg);background:var(--k-success);
  border-radius:var(--k-radius-sm);padding:0 var(--k-space-2)}
/* A tight control drops the free tag rather than clipping the model name. */
.ap-shell[data-ap-shell="model"]{container-type:inline-size}
@container (max-width: 130px){.ap-free{display:none}}
```

- [ ] **Step 6: Run the tests**

Run: `npx vitest run src/model/agentPicker.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/model/agentPicker.webview.js src/model/agentPicker.webview.css src/model/agentPicker.test.ts
git commit -m "feat(picker): route icon, model name and vendor stack in the closed control (ui:UI-R44)"
```

---

### Task 4: Grouped menu, full-id footer, keyboard navigation

**Files:**
- Modify: `src/model/agentPicker.webview.js`
- Modify: `src/model/agentPicker.webview.css`
- Test: `src/model/agentPicker.test.ts`

**Interfaces:**
- Consumes: `apParseModelId`, `apRouteIconHtml`, `apRouteName` (Tasks 2–3).
- Produces: `apModelOptionsHtml(catalog, provider, saved, inheritLabel, recentIds?, routes?, query?)` — the 6th/7th params are optional and preserve every earlier call; `apModelListHtml(models, saved, routes, skip, tagsOf)`; `apModelGroups(list)`; `apFilterModels(list, routes, q)`; menu markup `.ap-group-sub` and `.ap-menu-foot` (`data-ap-foot`), rows carrying `data-ap-full` + `title` and no `.ap-model-sub`.

- [ ] **Step 1: Write the failing test**

```ts
describe('route → vendor grouping and the full-id footer', () => {
  const fns = load() as {
    apModelOptionsHtml: (
      c: unknown, p: string, saved: string, inherit: string,
      recent?: string[], routes?: unknown, query?: string,
    ) => string;
  };
  const routes = {
    opencode: { name: 'OpenCode Zen', badge: 'Z', iconSvg: '' },
    'opencode-go': { name: 'OpenCode Go', badge: 'Go', iconSvg: '' },
    openrouter: { name: 'OpenRouter', badge: '', iconSvg: '' },
  };
  const mixed = {
    opencode2: [
      { id: 'opencode/big-pickle-free', label: 'big-pickle-free' },
      { id: 'opencode-go/space-bunny#high', label: 'Space Bunny', efforts: ['high'] },
      { id: 'openrouter/mancer/weaver', label: 'weaver' },
      { id: 'openrouter/liquid/lfm-2.5-2.6b:free', label: 'LFM 2.5 2.6B' },
    ],
  };

  it('heads each route group with its icon and name, then each vendor', () => {
    const out = fns.apModelOptionsHtml(mixed, 'opencode2', '', '', undefined, routes);
    const zen = out.indexOf('OpenCode Zen');
    const go = out.indexOf('OpenCode Go');
    const or = out.indexOf('OpenRouter');
    expect(zen).toBeGreaterThan(-1);
    expect(zen).toBeLessThan(go);
    expect(go).toBeLessThan(or);
    expect(out).toContain('class="ap-group-sub">mancer<');
    expect(out).toContain('class="ap-group-sub">liquid<');
    expect(out).toContain('class="ap-route"');
  });

  it('adds no route heading when every model is unrouted', () => {
    const out = fns.apModelOptionsHtml(catalog, 'claude', '', '');
    expect(out).not.toContain('ap-group-label');
  });

  it('drops the duplicate full-id line and puts it in the row title instead', () => {
    const out = fns.apModelOptionsHtml(mixed, 'opencode2', '', '', undefined, routes);
    expect(out).not.toContain('ap-model-sub');
    expect(out).toContain('title="openrouter/mancer/weaver"');
    expect(out).toContain('data-ap-full="openrouter/mancer/weaver"');
  });

  it('shows the variant and the free tag on the row', () => {
    const out = fns.apModelOptionsHtml(mixed, 'opencode2', '', '', undefined, routes);
    expect(out).toContain('<span class="ap-variant"> high</span>');
    expect(out).toContain('<span class="ap-free">free</span>');
  });

  it('filters on the model name, the vendor, the route id, the route name and the full id', () => {
    const byVendor = fns.apModelOptionsHtml(mixed, 'opencode2', '', '', undefined, routes, 'mancer');
    expect(byVendor).toContain('data-ap-model="openrouter/mancer/weaver"');
    expect(byVendor).not.toContain('space-bunny');
    const byRouteName = fns.apModelOptionsHtml(mixed, 'opencode2', '', '', undefined, routes, 'opencode go');
    expect(byRouteName).toContain('data-ap-model="opencode-go/space-bunny"');
    expect(byRouteName).not.toContain('weaver');
    const byFullId = fns.apModelOptionsHtml(mixed, 'opencode2', '', '', undefined, routes, 'liquid/lfm');
    expect(byFullId).toContain('data-ap-model="openrouter/liquid/lfm-2.5-2.6b"');
  });

  it('reports no match for a filter that hits nothing', () => {
    expect(fns.apModelOptionsHtml(mixed, 'opencode2', '', '', undefined, routes, 'zzz'))
      .toContain('No models match "zzz".');
  });

  it('keeps the saved-unavailable row reachable with its full id', () => {
    const out = fns.apModelOptionsHtml(mixed, 'opencode2', 'gone/model', '', undefined, routes);
    expect(out).toContain('Saved model (unavailable)');
    expect(out).toContain('data-ap-full="gone/model"');
  });

  it('ships the footer, arrow-key and Enter wiring', () => {
    expect(js).toContain('data-ap-foot');
    expect(js).toContain('aria-live="polite"');
    expect(js).toContain('function moveActive(');
    expect(js).toContain("e.key === 'ArrowDown'");
    expect(js).toContain("e.key === 'Enter'");
    expect(js).toContain('function syncMenuFoot(');
    expect(js).toContain('data-ap-search]');
    expect(js).toContain('.focus()');
  });

  it('pins the footer and sub-heading styles with tokens', () => {
    const css = agentPickerCss();
    expect(css).toMatch(/\.ap-group-sub\{[^}]*color:var\(--k-text-faint\)/);
    expect(css).toMatch(/\.ap-menu-foot\{[^}]*border-top:var\(--k-border-w\) solid var\(--k-border\)/);
    expect(css).toMatch(/\.ap-menu-foot\{[^}]*text-overflow:ellipsis/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/model/agentPicker.test.ts`
Expected: FAIL — no grouping, no footer, `ap-model-sub` still rendered.

- [ ] **Step 3: Rewrite the row builder and add the group builders**

Replace `apModelItemHtml` and add the grouping helpers:

```js
/** One model row: name + variant, capability chips, free tag, saved tag. */
function apModelItemHtml(m, saved, tags) {
  var sel = m.id === saved;
  var p = apParseModelId(m.id, m.label);
  var variant = p.variant ? '<span class="ap-variant"> ' + apEsc(p.variant) + '</span>' : '';
  var free = p.free ? '<span class="ap-free">free</span>' : '';
  // The full id lives in the row's title and data attribute (UI-R44) — the old
  // second line duplicated the name the user had just read.
  return '<div class="ap-model-item' + (sel ? ' active' : '') + '" role="option" tabindex="0"'
    + ' data-ap-model="' + apEsc(m.id) + '" aria-selected="' + (sel ? 'true' : 'false') + '"'
    + ' data-ap-full="' + apEsc(m.id) + '" title="' + apEsc(m.id) + '">'
    + '<div class="ap-model-main"><div class="ap-model-name">' + apEsc(p.model) + variant + '</div>'
    + apModelTagsHtml(tags)
    + '</div>'
    + free
    + (sel ? '<span class="ap-model-tag">saved</span>' : '')
    + '</div>';
}

/** Group models by route, then by vendor — first-appearance order, stable. */
function apModelGroups(models) {
  var groups = [];
  var byRoute = {};
  for (var i = 0; i < models.length; i++) {
    var p = apParseModelId(models[i].id, models[i].label);
    var rk = 'r:' + (p.route || '');
    var g = byRoute[rk];
    if (!g) {
      g = { route: p.route || '', vendors: [], byVendor: {} };
      byRoute[rk] = g;
      groups.push(g);
    }
    var vk = 'v:' + (p.vendor || '');
    var v = g.byVendor[vk];
    if (!v) { v = { vendor: p.vendor || '', models: [] }; g.byVendor[vk] = v; g.vendors.push(v); }
    v.models.push(models[i]);
  }
  return groups;
}

/** The rows for a set of models, grouped route → vendor; `skip` drops ids already shown. */
function apModelListHtml(models, saved, routes, skip, tagsOf) {
  var groups = apModelGroups(models);
  var named = groups.length > 1 || (groups.length === 1 && groups[0].route !== '');
  var out = '';
  for (var gi = 0; gi < groups.length; gi++) {
    var g = groups[gi];
    if (named) {
      out += '<div class="ap-group-label" role="presentation">'
        + apRouteIconHtml(g.route, routes)
        + '<span>' + apEsc(apRouteName(routes, g.route)) + '</span></div>';
    }
    for (var vi = 0; vi < g.vendors.length; vi++) {
      var v = g.vendors[vi];
      if (v.vendor) {
        out += '<div class="ap-group-sub" role="presentation">' + apEsc(v.vendor) + '</div>';
      }
      for (var mi = 0; mi < v.models.length; mi++) {
        var m = v.models[mi];
        if (skip && skip[m.id]) continue;
        out += apModelItemHtml(m, saved, tagsOf ? tagsOf(m.id) : undefined);
      }
    }
  }
  return out;
}

/** The catalog rows a search query keeps: model, vendor, route id, route name, full id. */
function apFilterModels(models, routes, q) {
  var out = [];
  for (var i = 0; i < models.length; i++) {
    var p = apParseModelId(models[i].id, models[i].label);
    var hay = (String(models[i].label || '') + ' ' + String(models[i].id || '') + ' '
      + p.route + ' ' + p.vendor + ' ' + apRouteName(routes, p.route)).toLowerCase();
    if (hay.indexOf(q) >= 0) out.push(models[i]);
  }
  return out;
}
```

- [ ] **Step 4: Rebuild `apModelOptionsHtml`**

```js
function apModelOptionsHtml(catalog, provider, saved, inheritLabel, recentIds, routes, query) {
  var list = (catalog && catalog[provider]) || [];
  var q = String(query === null || query === undefined ? '' : query).trim().toLowerCase();
  var tagsOf = function (id) { return apTags(catalog, provider, id); };
  if (q) {
    var hits = apFilterModels(list, routes, q);
    if (!hits.length) {
      return list.length
        ? '<div class="ap-empty">No models match "' + apEsc(query) + '".</div>'
        : '<div class="ap-empty">No models listed for this core.</div>';
    }
    return apModelListHtml(hits, saved, routes, {}, tagsOf);
  }
  var out = '';
  if (inheritLabel) {
    out += '<div class="ap-model-item' + (saved ? '' : ' active') + '" role="option" tabindex="0"'
      + ' data-ap-model="" aria-selected="' + (saved ? 'false' : 'true') + '">'
      + '<div class="ap-model-main"><div class="ap-model-name">' + apEsc(inheritLabel) + '</div></div></div>';
  }
  if (list.length === 0) {
    out += '<div class="ap-empty">No models listed for this core.</div>';
  } else {
    var recent = [];
    var recentSet = {};
    var recentList = recentIds || [];
    for (var r = 0; r < recentList.length && recent.length < 5; r++) {
      var rid = recentList[r];
      if (recentSet[rid]) continue;
      for (var i = 0; i < list.length; i++) {
        if (list[i].id === rid) { recent.push(list[i]); recentSet[rid] = true; break; }
      }
    }
    if (recent.length > 0 && recent.length < list.length) {
      out += '<div class="ap-group-label" role="presentation">Last used</div>';
    }
    for (var k = 0; k < recent.length; k++) {
      out += apModelItemHtml(recent[k], saved, tagsOf(recent[k].id));
    }
    out += apModelListHtml(list, saved, routes, recentSet, tagsOf);
  }
  if (saved && list.length > 0 && !list.some(function (m) { return m.id === saved; })) {
    out += '<div class="ap-group-label" role="presentation">Saved model (unavailable)</div>'
      + '<div class="ap-model-item active" role="option" tabindex="0" data-ap-model="'
      + apEsc(saved) + '" aria-selected="true" data-ap-full="' + apEsc(saved)
      + '" title="' + apEsc(saved) + '"><div class="ap-model-main"><div class="ap-model-name">'
      + apEsc(saved) + '</div></div></div>';
  }
  return out;
}
```

- [ ] **Step 5: Menu skeleton with the footer, and the focus/arrow/Enter/footer wiring**

Add beside `apTriggerLabelHtml`:

```js
/** The model menu's chrome: search, scroll area, and the full-id footer (UI-R44). */
function apModelMenuHtml() {
  return '<div class="ap-search"><input type="text" placeholder="Search models…"'
    + ' aria-label="Search models" data-ap-search /></div>'
    + '<div class="ap-scroll" data-ap-list="model"></div>'
    + '<div class="ap-menu-foot" aria-live="polite" data-ap-foot></div>';
}

/** The open menu's active row, if any. */
function apActiveOption(shell) {
  return shell ? shell.querySelector('[role="option"].active') : null;
}
```

Inside `mountAgentPicker` (beside `renderEffort`):

```js
  /** Point the footer at the keyboard-active row's full id (UI-R44). */
  function syncMenuFoot(shell) {
    if (!shell) return;
    var foot = shell.querySelector('[data-ap-foot]');
    if (!foot) return;
    var active = apActiveOption(shell);
    foot.textContent = active ? (active.getAttribute('data-ap-full') || '') : '';
  }

  /** Move the keyboard-active row by one; headings are not options, so they are skipped. */
  function moveActive(shell, delta) {
    var items = shell.querySelectorAll('[role="option"]');
    if (!items.length) return;
    var current = apActiveOption(shell);
    var idx = -1;
    for (var i = 0; i < items.length; i++) if (items[i] === current) { idx = i; break; }
    var next = idx < 0 ? (delta > 0 ? 0 : items.length - 1) : idx + delta;
    if (next < 0) next = 0;
    if (next > items.length - 1) next = items.length - 1;
    for (var j = 0; j < items.length; j++) items[j].classList.toggle('active', j === next);
    if (items[next].scrollIntoView) items[next].scrollIntoView({ block: 'nearest' });
    syncMenuFoot(shell);
  }
```

Replace the menu skeleton in the mount HTML and in `renderModel()` with `apModelMenuHtml()`, then:

```js
    if (kind === 'model') {
      var list = $('[data-ap-list="model"]');
      var opts = list ? list.querySelectorAll('[role="option"]') : [];
      var selected = list ? list.querySelector('[role="option"][aria-selected="true"]') : null;
      var first = selected || (opts.length ? opts[0] : null);
      if (first) first.classList.add('active');
      var search = menu.querySelector('[data-ap-search]');
      if (search && search.focus) search.focus();
      syncMenuFoot(shell);
    }
```

Replace the `input` handler body with:

```js
  root.addEventListener('input', function (e) {
    var search = e.target && e.target.getAttribute && e.target.getAttribute('data-ap-search');
    if (search === null) return;
    var listEl = $('[data-ap-list="model"]');
    if (!listEl) return;
    listEl.innerHTML = apModelOptionsHtml(
      catalog, state.core, state.model, labels().model, recent[state.core], routes, e.target.value,
    );
    var items = listEl.querySelectorAll('[role="option"]');
    for (var i = 0; i < items.length; i++) items[i].classList.remove('active');
    if (items.length) items[0].classList.add('active');
    syncMenuFoot($('[data-ap-shell="model"]'));
  });
```

Replace the `keydown` handler with:

```js
  root.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') {
      while (AP_MENU_STACK.length) closeMenu(AP_MENU_STACK[AP_MENU_STACK.length - 1], true);
      return;
    }
    var shell = AP_MENU_STACK.length ? AP_MENU_STACK[AP_MENU_STACK.length - 1] : null;
    if (!shell) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      moveActive(shell, e.key === 'ArrowDown' ? 1 : -1);
      return;
    }
    if (e.key === 'Enter') {
      var active = apActiveOption(shell);
      if (!active) return;
      e.preventDefault();
      active.click();
    }
  });
```

- [ ] **Step 6: Add the menu CSS**

```css
/* Menu grouping (route → vendor) and the UI-R44 full-id footer. The footer is
   OUTSIDE the scroll area, so it stays pinned (UI-R38) and announces the
   keyboard-active row's full id. */
.ap-group-sub{padding:0 var(--k-space-4) var(--k-space-1);color:var(--k-text-faint);font-size:var(--k-text-2xs)}
.ap-model-main{min-width:0}
.ap-menu-foot{padding:var(--k-space-2) var(--k-space-4);border-top:var(--k-border-w) solid var(--k-border);
  color:var(--k-text-dim);font-size:var(--k-text-2xs);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
```

Delete the now-unused `.ap-model-item .ap-model-sub{…}` rule.

- [ ] **Step 7: Run the tests**

Run: `npx vitest run src/model/agentPicker.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/model/agentPicker.webview.js src/model/agentPicker.webview.css src/model/agentPicker.test.ts
git commit -m "feat(picker): group the model menu route then vendor, full-id footer, arrow-key nav (ui:UI-R44)"
```

---

### Task 5: Pass `routes` in every picker host

**Files:**
- Modify: `src/model/agentPicker.ts` (document/export the option type)
- Modify: `src/ui/ticketForm/webview.html:1321`
- Modify: `src/ui/dashboard/webview.html:4557`
- Modify: `src/ui/settings/app/hostBridge.ts`
- Modify: `src/ui/settings/app/sections/usePickerInputs.ts`
- Modify: `src/ui/settings/app/sections/AgentPickerIsland.tsx`
- Modify: `src/ui/settings/app/sections/RoleRows.tsx`, `RolesTab.tsx`, `ApproachesSection.tsx`
- Test: `src/ui/settings/app/sections/*.test.tsx`, `src/ui/ticketForm/webview.test.ts`, `src/ui/dashboard/webview.test.ts`

**Interfaces:**
- Consumes: the `AP_ROUTES` global emitted by `agentPickerJs()`, `routeIdentityJs()`.
- Produces: `AgentPickerRoutes` type in `agentPicker.ts`; `AgentPickerOptions.routes?: AgentPickerRoutes`; `pageRoutes(scope?): AgentPickerRoutes`; `usePickerInputs()` also returns `routes`.

- [ ] **Step 1: Write the failing tests**

Add to `src/ui/ticketForm/webview.test.ts` and `src/ui/dashboard/webview.test.ts` (same shape — one per host):

```ts
it('hands the picker the route identity map', () => {
  expect(HTML).toContain('routes: AP_ROUTES,');
});
```

Add to `src/ui/settings/app/sections/RolesTab.test.tsx` (and mirror in `RolesTab`'s sibling tests where a picker mounts):

```tsx
it('passes the host route identity map to every picker', () => {
  const seen: unknown[] = [];
  (globalThis as unknown as Record<string, unknown>).mountAgentPicker = (
    _root: HTMLElement,
    opts: { routes?: unknown },
  ) => { seen.push(opts.routes); };
  (globalThis as unknown as Record<string, unknown>).AP_ROUTES = { openrouter: { name: 'OpenRouter' } };
  renderRolesTab();
  expect(seen[0]).toEqual({ openrouter: { name: 'OpenRouter' } });
  delete (globalThis as unknown as Record<string, unknown>).AP_ROUTES;
});
```

(Reuse the file's existing render helper and mount stub; delete both globals in teardown as the file already does.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/ui/ticketForm/webview.test.ts src/ui/dashboard/webview.test.ts src/ui/settings/app/sections/RolesTab.test.tsx`
Expected: FAIL — `routes: AP_ROUTES,` absent; `opts.routes` undefined.

- [ ] **Step 3: Document and type the option in `agentPicker.ts`**

Add to the header option list:

```ts
 *     routes,           // { [route]: { name, badge?, iconSvg } } host map from
 *                       // routeIdentity.ts; omitted = the pre-route look
```

and export the type:

```ts
/** One registered model route, as the picker runtime consumes it. */
export interface AgentPickerRoute {
  readonly name: string;
  readonly badge?: string;
  readonly iconSvg?: string;
}

/** Route id → identity; the `routes` option every host passes. */
export type AgentPickerRoutes = Readonly<Record<string, AgentPickerRoute>>;
```

- [ ] **Step 4: Pass it in the two vanilla hosts**

In `src/ui/ticketForm/webview.html` and `src/ui/dashboard/webview.html`, directly after the `catalog:` line of the `mountAgentPicker(root, { … })` call:

```js
      routes: AP_ROUTES,
```

- [ ] **Step 5: Pass it in the settings React host**

`hostBridge.ts` — extend the import type list and the two interfaces:

```ts
import type { AgentPickerRoutes } from '../../../../model/agentPicker.js';
...
export interface PageGlobals {
  ...
  /** The emitted route identity map (`agentPickerJs()` prefixes `var AP_ROUTES`). */
  readonly AP_ROUTES?: AgentPickerRoutes;
}
...
export interface AgentPickerOptions {
  ...
  /** Route id → identity (route icon + name + badge); omitted = the pre-route look. */
  readonly routes?: AgentPickerRoutes;
}
...
/** The host-supplied route identity map, or `{}` when the picker blob is absent. */
export function pageRoutes(scope: PageGlobals = globalThis as PageGlobals): AgentPickerRoutes {
  return scope.AP_ROUTES ?? {};
}
```

`usePickerInputs.ts`:

```ts
import { pageRoutes } from '../hostBridge.js';
...
  const routes = useMemo(() => pageRoutes(), []);
  return { catalog, recent, cores, routes };
```

`AgentPickerIsland.tsx` — include `routes` in the destructure and the effect dependency list:

```ts
  const { cores, catalog, recent, routes, inherit, inheritCore, showEffort, disabled, compact } = options;
...
  }, [mount, cores, catalog, recent, routes, inherit, inheritCore, showEffort, core, model, effort, disabled, compact]);
```

`RoleRows.tsx`, `RolesTab.tsx` — destructure `routes` and pass `routes={routes}` to each `<AgentPickerIsland …>`.
`ApproachesSection.tsx` — same for its `usePickerInputs()` destructure and its profile `AgentPickerIsland`.

- [ ] **Step 6: Run the tests**

Run: `npx vitest run src/ui/ticketForm/webview.test.ts src/ui/dashboard/webview.test.ts src/ui/settings/app/sections`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/model/agentPicker.ts src/ui/ticketForm/webview.html src/ui/dashboard/webview.html \
  src/ui/settings/app/hostBridge.ts src/ui/settings/app/sections
git commit -m "feat(picker): every host hands the picker its route identity map"
```

---

### Task 6: Record the ICONS-05 exception class

**Files:**
- Modify: `docs/ui/ICONS.md` (`[@ui:ICONS-05]`)

- [ ] **Step 1: Append item 4 to the ICONS-05 block**

```markdown
4. **Route/gateway logos** — `src/model/routeIdentity.ts` (`ROUTE_ICONS`): the
   OpenRouter and OpenCode marks, the same Lobe Icons monochrome SVGs the
   agent-core set uses. An unknown route renders a generated letter monogram (its
   first letter, on a hue derived from the route id, `aria-hidden`, with the route
   name in the trigger's accessible name) — a placeholder for a brand Karst has no
   asset for, not a new icon concept. Approved 2026-10-23 (T777).
```

- [ ] **Step 2: Verify the docs contract still passes**

Run: `npm run -s docs:lint`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add docs/ui/ICONS.md
git commit -m "docs(icons): route logos and the letter monogram are an ICONS-05 exception class (ui:ICONS-05)"
```

---

### Task 7: Gates, visual baselines and evidence

**Files:**
- Possibly regenerate: `tests/visual/__baselines__/*/agents-*.png` (**only with user approval**)

- [ ] **Step 1: Typecheck and lint**

Run: `npm run -s typecheck && npm run -s lint:react`
Expected: PASS.

- [ ] **Step 2: Unit suite**

Run: `npm run -s test:unit`
Expected: PASS.

- [ ] **Step 3: Layout gate**

Delete the served-fixture cache first (`tests/visual/.tmp`), then:

Run: `rm -rf tests/visual/.tmp && npm run -s test:layout`
Expected: PASS for the Agents routes; any NEW failure is investigated, never added to the ledger.

- [ ] **Step 4: Authoritative layout + visual gates**

Run: `npm run -s test:layout:docker 2>&1 | tail -40`
Run: `npm run -s test:visual:docker 2>&1 | tail -40`
Expected: layout ledger unchanged and empty of new Agents failures; visual diffs limited to `agents-*` (the routed-model rows now draw a route mark, a two-line stack and no duplicate id line).

- [ ] **Step 5: Get explicit approval of the baseline diff, then record it**

```bash
npm run -s test:visual:docker:update 2>&1 | tail -20
```

Show the changed `agents-*` images to the user and wait for approval **before** committing them. Commit exactly the approved PNGs, nothing else.

- [ ] **Step 6: Commit the approved baselines**

```bash
git add tests/visual/__baselines__
git commit -m "test(visual): re-record the agents baselines for the routed-model picker (ui:UI-R44)"
```

---

## Verification (recorded after implementation)

The `agents-*` baselines did **not** move, and that is correct: they are
1280×720 full-page shots of a settings page whose Roles table lives in an
internal scroll region below that crop, so no `agents-*` image can show the
picker. Visual evidence is therefore recorded where the picker IS inside the
captured area — the ticket form's full-page baseline (1280×1119):

- `tests/visual/variants.ts` — new `ticketForm/routed-model` variant (seeded
  with an OpenRouter 3-segment id, an OpenCode Go id, a `:free` id and a
  `-free` id), themes dark/light/hc.
- New baselines: `tests/visual/__baselines__/{dark,light,hc}/ticketForm--routed-model.png`
  (approved by the user 2026-10-24 before recording).
- Layout ledger: the new variant is a layout route, so its 15 template
  failures already carried by every sibling ticket-form route
  (`ticketForm/edit`, `/empty`, `/populated`) were backfilled verbatim —
  **0 unmatched (width, check, selector) keys**, the #722 precedent that proves
  no new bug was accepted.

Gate results on the final code:

| Command | Result |
| --- | --- |
| `npm run -s typecheck` / `lint:react` / `docs:lint` / `docs:graph -- --check` | exit 0 |
| `npm run -s test:unit` | 872 files, 15 034 tests pass |
| `npm run -s test:layout:docker` | 424 pass, exit 0, ledger verdict green |
| `npm run -s test:visual:docker` | 1 253 pass, 0 fail, 449 skipped |

Deviations from the plan above, made during implementation and reviewed here:

1. `apModelName(parsed, routes)` — a curated label that repeats the route
   heading ("OpenCode Go · MiMo v2.5") renders without the prefix, because the
   heading already names the gateway. Raw ids and non-matching labels are
   untouched.
2. The menu footer **wraps** (`overflow-wrap:anywhere`) instead of ellipsizing:
   a clipped footer is reported by layout check (d) as clipped text with no
   reachable full form (UI-R44).
3. `.ap-trigger:has(.ap-mstack)` tightens block padding and `.ap-mstack` uses
   `line-height:1.15`, so the two-line trigger stays inside
   `--k-control-h-lg`. Without it the routed Model control was ~34px against a
   30px Core control, breaking the D108 Core | Model | Effort alignment.
4. The route badge sits inline beside the mark (not absolutely positioned):
   at the mark's corner it overlapped the group-heading text.
5. `apMarkActive(items, index)` is the single highlight helper, and
   `apModelListHtml` drops a route group whose every row moved into "Last used"
   — the two review findings (one row highlighted, no heading over nothing).

### Failed review, round 2 — the two findings and their pins

| Finding | Fix | Pinned by |
| --- | --- | --- |
| **[high]** Enter/Arrow acted on another picker's open menu because the keydown handler read the page-global `AP_MENU_STACK` | `apMenuShellFor(root, stack)` returns only a shell this root contains; the handler answers keys from that shell, and Escape no longer closes a sibling picker's menu | `agentPicker.test.ts` → "a picker only drives its own open menu" (helper behaviour + a source contract on the handler) |
| **[medium]** the unknown-route monogram painted a fixed hue surface with the theme-dependent `--k-bg` as its glyph, so one theme always dropped below AA (ui:UI-R29) | the glyph is a fixed knockout (`#fff`) on a darkened fixed surface (`hsl(hue 55% 28%)`): 5.31:1 at worst over all 360 hues, independent of the theme. No theme variable can pair with a data-derived fill, so the pair is fixed and contrast-pinned | `agentPicker.test.ts` → "the unknown-route monogram pair (UI-R29)" (parses the CSS declaration and sweeps every hue) |

The monogram does not appear in `ticketForm/routed-model` (it renders only for
routes with no asset), and its surface/glyph pair is theme-independent, so no
visual baseline moves.

---

## Self-review

**Spec coverage**

| Spec item | Task |
| --- | --- |
| Step 1 parser (+ all listed cases) | Task 2 |
| Step 2 routeIdentity + icons + copy-assets | Task 1 |
| Step 3 `routes` option in all hosts | Task 5 |
| Step 4 trigger stack + aria-label | Task 3 |
| Step 5 CSS (ellipsis, never-shrinking free, container query) | Task 3 |
| Step 6 menu grouping, footer, filter fields, ↑↓/Enter/Esc, sub-line removed | Task 4 |
| Step 7 catalog fields | Dropped (user-approved) |
| Step 8 monogram | Task 3 (+ doc in Task 6) |
| Conflict approvals recorded | Task 6 |
| "Done when" gates + baselines | Task 7 |

**Placeholders:** none — every step carries the code, selector or command it needs.

**Type consistency:** `AgentPickerRoute(s)` (Task 5) is the type of the `routes` option consumed by `apRouteIconHtml`/`apRouteName` (Task 3); `apParseModelId` (Task 2) is the single parser used by Tasks 3 and 4; `apModelItemHtml(m, saved, tags)` keeps its three-argument shape when the sub-line is removed (Task 4), so `apModelOptionsHtml`'s existing call sites stay valid.

**Known risk recorded:** the ticket's prototype URL could not be read in this session; the step text is the binding shape (user-approved), and UI-R39's rule priority (tokens/controls/spacing win) is unaffected.
