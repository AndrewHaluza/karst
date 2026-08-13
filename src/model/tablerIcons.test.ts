import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  TABLER_ICONS,
  TABLER_VIEWBOX,
  TABLER_STROKE,
  TABLER_ATTRIBUTION,
  tablerIconsCss,
  tablerIconsJs,
} from './tablerIcons.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const UI = join(HERE, '..', 'ui');

/**
 * The Tabler Icons standard: 24×24 viewBox, stroke-width 2, round caps and
 * joins, `currentColor` stroke, no fill. Every glyph in the catalog must carry
 * exactly this treatment — the whole point of the library is that no surface
 * re-tunes an icon ad hoc (docs/ui/ICONS.md §4).
 */
describe('Tabler icon catalog (src/model/tablerIcons.ts)', () => {
  it('carries the Tabler MIT attribution in the module header', () => {
    expect(TABLER_ATTRIBUTION).toMatch(/tabler icons/i);
    expect(TABLER_ATTRIBUTION).toContain('MIT');
    expect(TABLER_ATTRIBUTION).toMatch(/copyright/i);
    expect(TABLER_ATTRIBUTION).toContain('https://github.com/tabler/tabler-icons');
  });

  it('is a closed, non-empty set of interaction glyphs', () => {
    const names = Object.keys(TABLER_ICONS);
    expect(names.length).toBeGreaterThan(10);
    for (const name of names) {
      expect(name, `catalog key ${name}`).toMatch(/^[a-z0-9-]+$/);
      expect(TABLER_ICONS[name], `catalog entry ${name}`).toContain('<path');
    }
  });

  it('keeps every glyph on the single shared viewBox and stroke', () => {
    // The standard is what "a single consistent Tabler stroke/size treatment"
    // means (docs/ui/ICONS.md §4): one viewBox, one stroke-width, one cap/join
    // style, currentColor, no fill. Nothing may drift per-glyph.
    expect(TABLER_VIEWBOX).toBe(24);
    expect(TABLER_STROKE).toBe(2);
  });

  it('pins the vendored path data to the official Tabler bytes', () => {
    // Verbatim from the Tabler Icons repo (icons/outline, MIT). These pins are
    // what keep a future hand-edit from silently replacing a glyph with a
    // local approximation — the vendored data must stay the upstream bytes.
    expect(TABLER_ICONS['check']).toBe('<path d="M5 12l5 5l10 -10"/>');
    expect(TABLER_ICONS['player-play']).toBe('<path d="M7 4v16l13 -8l-13 -8"/>');
    expect(TABLER_ICONS['terminal-2']).toBe(
      '<path d="M8 9l3 3l-3 3"/><path d="M13 15l3 0"/><path d="M3 6a2 2 0 0 1 2 -2h14a2 2 0 0 1 2 2v12a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2l0 -12"/>',
    );
  });

  it('emits the icon runtime with every catalog entry', () => {
    const js = tablerIconsJs();
    expect(js).toContain('function karstIcon(');
    for (const name of Object.keys(TABLER_ICONS)) {
      expect(js, `runtime missing ${name}`).toContain(`"${name}":`);
    }
  });

  it('emits the shared .k-icon stroke treatment', () => {
    const css = tablerIconsCss();
    expect(css).toContain('.k-icon{');
    expect(css).toContain('stroke-width:2');
    expect(css).toContain('stroke:currentColor');
    expect(css).toContain('fill:none');
    expect(css).toContain('stroke-linecap:round');
    expect(css).toContain('stroke-linejoin:round');
  });
});

/**
 * The runtime is SHIPPED STRING — the same trade designRuntime.test.ts makes.
 * Evaluating the emitted bytes (never a TS twin) is what keeps the webview
 * render honest.
 */
describe('karstIcon runtime', () => {
  const render = (expr: string): string => {
    const ctx: Record<string, unknown> = {};
    runInNewContext(tablerIconsJs(), ctx);
    return runInNewContext(expr, ctx) as string;
  };

  it('renders a 24-viewBox svg with the central stroke class', () => {
    const out = render('karstIcon("refresh")');
    expect(out).toMatch(/^<svg class="k-icon"/);
    expect(out).toContain('viewBox="0 0 24 24"');
    expect(out).toContain('width="16" height="16"');
    expect(out).toContain('aria-hidden="true"');
    expect(out).toContain('focusable="false"');
    expect(out).toContain('<path d="M20 11a8.1');
  });

  it('sizes from the caller, adds an extra class when asked', () => {
    expect(render('karstIcon("refresh", 12, "reload-icon")')).toContain(
      'class="k-icon reload-icon" width="12" height="12"',
    );
  });

  it('renders empty for an unknown name — render never throws', () => {
    expect(render('karstIcon("no-such-glyph")')).toBe('');
  });

  it('renders every catalog entry at 16px without throwing', () => {
    for (const name of Object.keys(TABLER_ICONS)) {
      const out = render(`karstIcon(${JSON.stringify(name)})`);
      expect(out, name).toContain(`<path`);
      expect(out, name).not.toContain('undefined');
    }
  });
});

/**
 * DISCOVERED, never enumerated — the same reasoning as designSystem.test.ts:
 * a webview that reaches for an icon not in the catalog (or keeps a hand-rolled
 * sprite) ships a glyph that is neither Tabler nor centrally defined. The
 * catalog is the only icon vocabulary the UI may use (docs/ui/ICONS.md §2).
 */
const WEBVIEWS = readdirSync(UI, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name)
  .filter((name) => {
    try {
      readFileSync(join(UI, name, 'webview.html'));
      return true;
    } catch {
      return false;
    }
  });

const read = (name: string): string => readFileSync(join(UI, name, 'webview.html'), 'utf8');

describe('icon use across webviews', () => {
  it('every karstIcon() call resolves to a catalog entry', () => {
    let found = 0;
    for (const name of WEBVIEWS) {
      const html = read(name);
      // Direct calls (sidebar), the dashboard's `svgIcon`/`iact` aliases — any
      // literal that names a glyph must name a catalog entry.
      const literals = [
        ...html.matchAll(/karstIcon\(\s*'([a-z0-9-]+)'/g),
        ...html.matchAll(/svgIcon\(\s*'([a-z0-9-]+)'/g),
        ...html.matchAll(/iact\([^,]+,[^,]+,[^,]+,\s*'([a-z0-9-]+)'/g),
      ].map((m) => m[1]!);
      for (const icon of literals) {
        found += 1;
        expect(Object.keys(TABLER_ICONS), `${name} uses unknown icon ${icon}`).toContain(icon);
      }
    }
    expect(found, 'no webview names an icon — the guard would be dead').toBeGreaterThan(0);
  });

  it('every static .k-icon svg in a webview carries Tabler viewBox and catalog paths', () => {
    const dSet = new Set(Object.values(TABLER_ICONS).map((p) => [...p.matchAll(/d="([^"]+)"/g)].map((m) => m[1]!).join('|')));
    let found = 0;
    for (const name of WEBVIEWS) {
      const html = read(name);
      for (const svg of html.matchAll(/<svg\b([^>]*\bclass="[^"]*\bk-icon\b[^"]*"[^>]*)>([\s\S]*?)<\/svg>/g)) {
        found += 1;
        expect(svg[1]!, `${name} static icon without 24 viewBox`).toContain('viewBox="0 0 24 24"');
        const d = [...svg[2]!.matchAll(/d="([^"]+)"/g)].map((m) => m[1]!).join('|');
        expect(dSet, `${name} static icon path not in catalog`).toContain(d);
      }
    }
    expect(found, 'no static .k-icon svg found — the guard would be dead').toBeGreaterThan(0);
  });

  it('leaves no hand-rolled icon sprite in any webview', () => {
    for (const name of WEBVIEWS) {
      expect(read(name), `${name} still defines a custom sprite glyph`).not.toMatch(/<g id="i-/);
      expect(read(name), `${name} still references a sprite glyph`).not.toContain('href="#i-');
    }
  });
});
