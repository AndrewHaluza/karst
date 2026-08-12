/**
 * The Tabler Icons catalog — Karst's single icon vocabulary (docs/ui/ICONS.md).
 *
 * Karst used to hand-roll interaction glyphs per webview: the dashboard's
 * 16px sprite (open/copy/restart/stop/start/…) and the sidebar's own row of
 * inline SVGs were a second icon set nobody could add to consistently. Tabler
 * Icons is the standard library instead: MIT-licensed (attribution below),
 * stroke-based, and broad enough for developer/tooling concepts — terminal,
 * process control, diffing, archiving — that a bespoke set re-creates one by
 * one.
 *
 * THE CONTRACT (docs/ui/ICONS.md §2–§4):
 *
 *  - `TABLER_ICONS` is the ONLY icon vocabulary the UI may use. Every glyph is
 *    the VERBATIM upstream path data from the Tabler Icons repo
 *    (`icons/outline/<name>.svg`) — never a local redraw, never a re-tuned
 *    stroke. `tablerIcons.test.ts` pins selected bytes and discovers every
 *    `karstIcon(...)` call and static `.k-icon` svg in every webview, so a
 *    drift fails `npm test`.
 *  - Every glyph renders on ONE treatment: 24×24 viewBox, stroke-width 2,
 *    round caps/joins, `currentColor`, no fill — the canonical Tabler render
 *    (`TABLER_VIEWBOX`/`TABLER_STROKE`), applied centrally by `.k-icon` and by
 *    `karstIcon()`. Size is a per-context choice (16px default, 12–15px in
 *    compact rows) and never changes the stroke.
 *  - Product-specific identity marks — the karst brand mark, agent-core logos
 *    (`agentIdentity.ts`), provider logos (`providerIdentity.ts`) — are
 *    exceptions, not interaction icons; they stay outside the catalog
 *    (docs/ui/ICONS.md §5).
 *
 * Delivery is the design-system marker path: `tablerIconsJs()` rides
 * `/*KARST_DS_JS*\/` and `tablerIconsCss()` rides `/*KARST_DS_CSS*\/` with
 * `injectDesignSystem`, so every webview has the catalog and `karstIcon()` by
 * construction — a new screen never needs a second icon mechanism (UI-R01).
 */

/**
 * Tabler Icons (https://tabler-icons.io/)
 * Copyright (c) 2018-present Paweł Kuna and contributors
 * Licensed under the MIT License — see THIRD_PARTY_NOTICES.md.
 */
export const TABLER_ATTRIBUTION =
  'Tabler Icons (https://github.com/tabler/tabler-icons) — Copyright (c) 2018-present ' +
  'Paweł Kuna and contributors — MIT License, see THIRD_PARTY_NOTICES.md';

/** The one viewBox every glyph renders on. */
export const TABLER_VIEWBOX = 24;

/** The one stroke width — Tabler's canonical 2 on a 24 grid. */
export const TABLER_STROKE = 2;

/**
 * name → inner `<path>` markup, verbatim from
 * `https://raw.githubusercontent.com/tabler/tabler-icons/main/icons/outline/<name>.svg`.
 * Adding an icon = adding the upstream bytes here; nothing else in the repo
 * needs to change for a new glyph to be usable everywhere.
 */
export const TABLER_ICONS: Record<string, string> = {
  archive:
    '<path d="M3 6a2 2 0 0 1 2 -2h14a2 2 0 0 1 2 2a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2"/>' +
    '<path d="M5 8v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2 -2v-10"/><path d="M10 12l4 0"/>',
  check: '<path d="M5 12l5 5l10 -10"/>',
  'chevron-down': '<path d="M6 9l6 6l6 -6"/>',
  'chevron-right': '<path d="M9 6l6 6l-6 6"/>',
  'circle-check':
    '<path d="M3 12a9 9 0 1 0 18 0a9 9 0 1 0 -18 0"/><path d="M9 12l2 2l4 -4"/>',
  'circle-x': '<path d="M3 12a9 9 0 1 0 18 0a9 9 0 1 0 -18 0"/><path d="M10 10l4 4m0 -4l-4 4"/>',
  copy:
    '<path d="M7 9.667a2.667 2.667 0 0 1 2.667 -2.667h8.666a2.667 2.667 0 0 1 2.667 2.667v8.666a2.667 2.667 0 0 1 -2.667 2.667h-8.666a2.667 2.667 0 0 1 -2.667 -2.667l0 -8.666"/>' +
    '<path d="M4.012 16.737a2.005 2.005 0 0 1 -1.012 -1.737v-10c0 -1.1 .9 -2 2 -2h10c.75 0 1.158 .385 1.5 1"/>',
  'external-link':
    '<path d="M12 6h-6a2 2 0 0 0 -2 2v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2 -2v-6"/>' +
    '<path d="M11 13l9 -9"/><path d="M15 4h5v5"/>',
  'git-compare':
    '<path d="M4 6a2 2 0 1 0 4 0a2 2 0 1 0 -4 0"/><path d="M16 18a2 2 0 1 0 4 0a2 2 0 1 0 -4 0"/>' +
    '<path d="M11 6h5a2 2 0 0 1 2 2v8"/><path d="M14 9l-3 -3l3 -3"/>' +
    '<path d="M13 18h-5a2 2 0 0 1 -2 -2v-8"/><path d="M10 15l3 3l-3 3"/>',
  history: '<path d="M12 8l0 4l2 2"/><path d="M3.05 11a9 9 0 1 1 .5 4m-.5 5v-5h5"/>',
  'layout-dashboard':
    '<path d="M5 4h4a1 1 0 0 1 1 1v6a1 1 0 0 1 -1 1h-4a1 1 0 0 1 -1 -1v-6a1 1 0 0 1 1 -1"/>' +
    '<path d="M5 16h4a1 1 0 0 1 1 1v2a1 1 0 0 1 -1 1h-4a1 1 0 0 1 -1 -1v-2a1 1 0 0 1 1 -1"/>' +
    '<path d="M15 12h4a1 1 0 0 1 1 1v6a1 1 0 0 1 -1 1h-4a1 1 0 0 1 -1 -1v-6a1 1 0 0 1 1 -1"/>' +
    '<path d="M15 4h4a1 1 0 0 1 1 1v2a1 1 0 0 1 -1 1h-4a1 1 0 0 1 -1 -1v-2a1 1 0 0 1 1 -1"/>',
  pencil:
    '<path d="M4 20h4l10.5 -10.5a2.828 2.828 0 1 0 -4 -4l-10.5 10.5v4"/><path d="M13.5 6.5l4 4"/>',
  'player-play': '<path d="M7 4v16l13 -8l-13 -8"/>',
  'player-pause':
    '<path d="M6 6a1 1 0 0 1 1 -1h2a1 1 0 0 1 1 1v12a1 1 0 0 1 -1 1h-2a1 1 0 0 1 -1 -1l0 -12"/><path d="M14 6a1 1 0 0 1 1 -1h2a1 1 0 0 1 1 1v12a1 1 0 0 1 -1 1h-2a1 1 0 0 1 -1 -1l0 -12"/>',
  'player-stop': '<path d="M5 7a2 2 0 0 1 2 -2h10a2 2 0 0 1 2 2v10a2 2 0 0 1 -2 2h-10a2 2 0 0 1 -2 -2l0 -10"/>',
  plus: '<path d="M12 5l0 14"/><path d="M5 12l14 0"/>',
  refresh:
    '<path d="M20 11a8.1 8.1 0 0 0 -15.5 -2m-.5 -4v4h4"/><path d="M4 13a8.1 8.1 0 0 0 15.5 2m.5 4v-4h-4"/>',
  search: '<path d="M3 10a7 7 0 1 0 14 0a7 7 0 1 0 -14 0"/><path d="M21 21l-6 -6"/>',
  'server-2':
    '<path d="M3 7a3 3 0 0 1 3 -3h12a3 3 0 0 1 3 3v2a3 3 0 0 1 -3 3h-12a3 3 0 0 1 -3 -3v-2"/>' +
    '<path d="M3 15a3 3 0 0 1 3 -3h12a3 3 0 0 1 3 3v2a3 3 0 0 1 -3 3h-12a3 3 0 0 1 -3 -3l0 -2"/>' +
    '<path d="M7 8l0 .01"/><path d="M7 16l0 .01"/><path d="M11 8h6"/><path d="M11 16h6"/>',
  settings:
    '<path d="M10.325 4.317c.426 -1.756 2.924 -1.756 3.35 0a1.724 1.724 0 0 0 2.573 1.066c1.543 -.94 3.31 .826 2.37 2.37a1.724 1.724 0 0 0 1.065 2.572c1.756 .426 1.756 2.924 0 3.35a1.724 1.724 0 0 0 -1.066 2.573c.94 1.543 -.826 3.31 -2.37 2.37a1.724 1.724 0 0 0 -2.572 1.065c-.426 1.756 -2.924 1.756 -3.35 0a1.724 1.724 0 0 0 -2.573 -1.066c-1.543 .94 -3.31 -.826 -2.37 -2.37a1.724 1.724 0 0 0 -1.065 -2.572c-1.756 -.426 -1.756 -2.924 0 -3.35a1.724 1.724 0 0 0 1.066 -2.573c-.94 -1.543 .826 -3.31 2.37 -2.37c1 .608 2.296 .07 2.572 -1.065"/>' +
    '<path d="M9 12a3 3 0 1 0 6 0a3 3 0 0 0 -6 0"/>',
  'terminal-2':
    '<path d="M8 9l3 3l-3 3"/><path d="M13 15l3 0"/>' +
    '<path d="M3 6a2 2 0 0 1 2 -2h14a2 2 0 0 1 2 2v12a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2l0 -12"/>',
  trash:
    '<path d="M4 7l16 0"/><path d="M10 11l0 6"/><path d="M14 11l0 6"/>' +
    '<path d="M5 7l1 12a2 2 0 0 0 2 2h8a2 2 0 0 0 2 -2l1 -12"/><path d="M9 7v-3a1 1 0 0 1 1 -1h4a1 1 0 0 1 1 1v3"/>',
};

/** Default render size in CSS px for `karstIcon()` (16px toolbar baseline). */
export const TABLER_ICON_SIZE = 16;

/**
 * The shared stroke/size treatment, emitted into every webview's `<style>` via
 * `/*KARST_DS_CSS*\/`. `.k-icon` carries ONLY the canonical Tabler treatment
 * (docs/ui/ICONS.md §4); per-surface geometry (a row's 13px, a button's
 * token-derived size) stays local, exactly like any other screen-local layout.
 */
export function tablerIconsCss(): string {
  return [
    '/* Shared Tabler icon treatment (docs/ui/ICONS.md §4): one viewBox, one',
    '   stroke, currentColor, no fill. The glyph markup comes from the injected',
    '   runtime or is inlined from the catalog; this rule is what keeps every',
    '   surface on the SAME stroke regardless of how the icon reached the DOM. */',
    `.k-icon{display:inline-block;vertical-align:-0.125em;flex:none;fill:none;`,
    `stroke:currentColor;stroke-width:${TABLER_STROKE};`,
    `stroke-linecap:round;stroke-linejoin:round}`,
  ].join('\n');
}

/**
 * The webview-side icon runtime, emitted as plain statements via
 * `/*KARST_DS_JS*\/` (docs/ui/ICONS.md §3). `karstIcon` renders the full
 * `<svg>` with the canonical attributes; an unknown name renders `''` — the
 * render never throws (the catalog test catches a misspelled name at test
 * time, same contract as `applyTransforms`).
 */
export function tablerIconsJs(): string {
  return `
// ── Karst Tabler icon runtime (docs/ui/ICONS.md §3) ──────────────────────────
var KARST_TABLER_ICONS = ${JSON.stringify(TABLER_ICONS)};

/**
 * Full inline svg for a catalog glyph. size is CSS px (default 16); cls is an
 * optional extra class beside .k-icon. Unknown name → '' — never a throw.
 */
function karstIcon(name, size, cls) {
  var paths = KARST_TABLER_ICONS[name];
  if (!paths) return '';
  size = size || ${TABLER_ICON_SIZE};
  var k = 'k-icon' + (cls ? ' ' + cls : '');
  return '<svg class="' + k + '" width="' + size + '" height="' + size
    + '" viewBox="0 0 ${TABLER_VIEWBOX} ${TABLER_VIEWBOX}" aria-hidden="true" focusable="false">'
    + paths + '</svg>';
}
`.trim();
}
