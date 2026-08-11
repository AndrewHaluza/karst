# Brand #35 Logo Replacement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the old three-node-graph Karst mark with the approved #35 split-shell/core mark on every product surface, preserving the approved geometry byte-for-byte and the status-tint machinery.

**Architecture:** Two assets ship in `media/`: `karst.svg` (full-color approved mark, canonical — activity bar + status-free tab icons + getting-started splash) and `karst-mark.svg` (monochrome silhouette of the SAME geometry with `fill="currentColor"` — status-tinted surfaces only, per "one-color fallback where the UI technically requires it"). The raster `karst-logo-35-approved-4096.png` is stored as the canonical raster export. `tintSvg`/`glyphIconPath` are untouched; only the asset path fed to them changes. `brandIconPaths` stops tinting (the full-color mark carries its own colors) and materializes ONE file for both themes. The sidebar row marker inline SVG swaps to the monochrome geometry; the getting-started h1 gains the full-color mark.

**Tech Stack:** TypeScript, VS Code extension API, vitest, raw SVG.

## Global Constraints

- Geometry byte-identical to `/Users/nd/Downloads/karst-logo-35-approved.svg` — the canonical source. The three shape definitions are load-bearing and MUST NOT be re-derived or simplified:
  - Left shell: `M 96 20 L 25 67 L 25 156 L 98 203 L 98 180 L 44 145 L 44 78 L 97 44 Z`
  - Right shell: `M 151 42 L 138 58 L 170 78 L 170 144 L 138 165 L 150 180 L 188 156 L 188 67 Z`
  - Core: `circle cx="106.5" cy="111.5" r="26.5"`
- Gradient stops verbatim: leftGrad `#7D48E9/#7D3CEE/#4A71D7`, rightGrad `#00B7C9/#00AFC0/#00B1C4`, coreGrad `#6647DE/#5660D9/#3586D6`.
- The old geometry (three-node graph: `cx="6"`, `cx="18"`, `cy="18"`, `7.6 7.6`) is REMOVED from `src/` and `media/` — product surfaces only; dated design docs (`docs/superpowers/`, `docs/plans/00*`, `docs/design/prototypes/`) are records and are NOT rewritten.
- `media/karst.svg` filename and the `BRAND_SVG` const name stay — `package.json` and `extension.ts` reference them.
- Status-tint surfaces (terminal tabs, dashboard tabs, sidebar row markers) get the monochrome silhouette — a multicolor gradient mark cannot carry a status glyph hue.
- Status-free surfaces (activity bar icon, settings/usage/diffs/welcome/ticket-form-create tab icons, getting-started splash) get the full-color mark.
- `tintSvg` (replaceAll `currentColor`) contract is unchanged; the monochrome mark must expose `currentColor` in a `fill` attribute.
- No UI framework introduced; webviews stay self-contained documents (UI-R01). Design-system tokens (`--k-*`) are used for the splash header layout.

---

## File Structure

| File | Responsibility |
|---|---|
| `media/karst.svg` | Full-color approved #35 mark — canonical geometry + gradients (activity bar, status-free tabs, splash) |
| `media/karst-mark.svg` | Monochrome silhouette of the same geometry, `fill="currentColor"` — status-tinted surfaces |
| `media/karst-logo-35-approved-4096.png` | Canonical raster export (copied from the approved asset) |
| `src/ui/brandIcon.ts` | Materialize the full-color mark once; `{light,dark}` both point at it |
| `src/extension.ts` | `MARK_SVG` const; feed it to both `glyphIconPath` call sites; `BRAND_SVG` stays for brand tabs |
| `src/ui/sidebar/webview.html` | Inline row marker → monochrome geometry (13×13) |
| `src/ui/gettingStarted/webview.html` | h1 header gains full-color mark (inline SVG, local gradients) |
| `src/ui/brandAssets.test.ts` | Geometry pin: assets match approved, old mark absent, monochrome is tintable |
| `src/ui/brandIcon.test.ts` | Update: one file, both themes, no tint |
| `src/ui/sidebar/webview.test.ts` | Pin: new geometry in row marker, old circles gone |
| `src/ui/gettingStarted/webview.test.ts` | Pin: splash mark present, old mark absent |

## Task 1: Ship approved assets + geometry pins

**Files:**
- Create: `media/karst.svg` (content = approved SVG verbatim)
- Create: `media/karst-mark.svg`
- Create: `media/karst-logo-35-approved-4096.png` (copy of the approved raster)
- Test: `src/ui/brandAssets.test.ts`

- [ ] **Step 1: Copy the approved SVG into `media/karst.svg`** (filename keeps the `package.json`/`BRAND_SVG` reference)

```bash
cp "/Users/nd/Downloads/karst-logo-35-approved.svg" media/karst.svg
cp "/Users/nd/Downloads/karst-logo-35-approved-4096.png" media/karst-logo-35-approved-4096.png
```

- [ ] **Step 2: Write the failing geometry-pin test** (`src/ui/brandAssets.test.ts`)

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tintSvg } from './glyphIcon.js';

const MEDIA = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'media');

const LEFT_SHELL = 'M 96 20 L 25 67 L 25 156 L 98 203 L 98 180 L 44 145 L 44 78 L 97 44 Z';
const RIGHT_SHELL = 'M 151 42 L 138 58 L 170 78 L 170 144 L 138 165 L 150 180 L 188 156 L 188 67 Z';

describe('brand assets', () => {
  const full = readFileSync(join(MEDIA, 'karst.svg'), 'utf8');
  const mark = readFileSync(join(MEDIA, 'karst-mark.svg'), 'utf8');

  it('karst.svg carries the approved geometry verbatim (no drift)', () => {
    expect(full).toContain(LEFT_SHELL);
    expect(full).toContain(RIGHT_SHELL);
    expect(full).toContain('<circle cx="106.5" cy="111.5" r="26.5"');
  });

  it('karst.svg keeps the approved gradients verbatim', () => {
    for (const hex of ['#7D48E9', '#7D3CEE', '#4A71D7', '#00B7C9', '#00AFC0', '#00B1C4', '#6647DE', '#5660D9', '#3586D6']) {
      expect(full).toContain(hex);
    }
  });

  it('the old three-node graph is gone from both assets', () => {
    for (const svg of [full, mark]) {
      expect(svg).not.toContain('cx="6"');
      expect(svg).not.toContain('cx="18"');
      expect(svg).not.toContain('cy="18"');
      expect(svg).not.toContain('7.6 7.6');
    }
  });

  it('karst-mark.svg is the SAME geometry as a currentColor silhouette', () => {
    expect(mark).toContain(LEFT_SHELL);
    expect(mark).toContain(RIGHT_SHELL);
    expect(mark).toContain('<circle cx="106.5" cy="111.5" r="26.5"');
    expect(mark).not.toContain('linearGradient');
    expect(mark).toContain('currentColor');
  });

  it('tinting the monochrome mark replaces every currentColor (tintSvg contract)', () => {
    const tinted = tintSvg(mark, '#e35555');
    expect(tinted).not.toContain('currentColor');
    expect(tinted).toContain('#e35555');
  });
});
```

- [ ] **Step 3: Run the test — it fails for `karst-mark.svg` (missing) and the old geometry in `karst.svg`**

Run: `npx vitest run src/ui/brandAssets.test.ts`
Expected: FAIL — `karst-mark.svg` does not exist; `karst.svg` still contains `cx="6"`.

- [ ] **Step 4: Create `media/karst-mark.svg`** — same three shapes, all `fill="currentColor"`, no gradients

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 215 215" width="215" height="215">
  <path d="M 96 20 L 25 67 L 25 156 L 98 203 L 98 180 L 44 145 L 44 78 L 97 44 Z" fill="currentColor"/>
  <path d="M 151 42 L 138 58 L 170 78 L 170 144 L 138 165 L 150 180 L 188 156 L 188 67 Z" fill="currentColor"/>
  <circle cx="106.5" cy="111.5" r="26.5" fill="currentColor"/>
</svg>
```

- [ ] **Step 5: Run the test — the old-geometry assertions still fail**

Run: `npx vitest run src/ui/brandAssets.test.ts`
Expected: FAIL only on the old-geometry assertions (`cx="6"` still in `karst.svg`).

- [ ] **Step 6: Replace `media/karst.svg` with the approved full-color mark** (already copied in Step 1 — verify it no longer contains the old graph; the copy IS the replacement)

- [ ] **Step 7: Run the test — GREEN**

Run: `npx vitest run src/ui/brandAssets.test.ts`
Expected: PASS (all 5 tests).

- [ ] **Step 8: Commit**

```bash
git add media/karst.svg media/karst-mark.svg media/karst-logo-35-approved-4096.png src/ui/brandAssets.test.ts
git commit -m "feat(brand): ship approved #35 mark assets + geometry pins"
```

## Task 2: brandIconPaths materializes the full-color mark once

**Files:**
- Modify: `src/ui/brandIcon.ts`
- Test: `src/ui/brandIcon.test.ts`

- [ ] **Step 1: Write the failing tests (update `brandIcon.test.ts`)**

Replace the "bakes a theme foreground" and "different files and different hues" tests with:

```ts
it('materializes ONE full-color file and returns it for both themes', () => {
  const p = paths();
  expect(p.light).toBe(p.dark);
  expect(readFileSync(p.light, 'utf8')).toContain('<circle cx="106.5" cy="111.5" r="26.5"');
});

it('does not tint — the approved mark carries its own colors (no currentColor, no brand hex)', () => {
  const p = paths();
  const content = readFileSync(p.light, 'utf8');
  expect(content).not.toContain('currentColor');
  expect(content).not.toContain(BRAND_ICON_HEX.light); // removed const — see Step 3
});
```

- [ ] **Step 2: Run — fails (brandIcon.ts still tints and writes two files)**

Run: `npx vitest run src/ui/brandIcon.test.ts`
Expected: FAIL.

- [ ] **Step 3: Rewrite `brandIcon.ts`** — drop `BRAND_ICON_HEX` and `tintSvg`, materialize `karst-brand.svg` once, return it for both themes

```ts
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The karst mark for tabs that carry NO status — settings, usage, changes,
 * welcome, and a create-mode ticket form with no ticket bound yet. Those
 * panels have nothing for the status ramp to say, so the mark is rendered in
 * its approved full-color treatment rather than in a glyph hue: a Settings
 * tab tinted `gray` would read as an idle ticket.
 *
 * The full-color mark works on both light and dark themes (approved contrast),
 * so one materialized file serves both entries of the `{light, dark}` pair
 * VS Code's `iconPath` expects.
 */
export interface BrandIconPaths {
  light: string;
  dark: string;
}

export function brandIconPaths(opts: {
  storageDir: string;
  assetSvgPath: string;
}): BrandIconPaths {
  const dir = join(opts.storageDir, 'icons');
  const file = join(dir, 'karst-brand.svg');
  if (!existsSync(file)) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, readFileSync(opts.assetSvgPath, 'utf8'), 'utf8');
  }
  return { light: file, dark: file };
}
```

- [ ] **Step 4: Run — GREEN**

Run: `npx vitest run src/ui/brandIcon.test.ts src/ui/glyphIcon.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ui/brandIcon.ts src/ui/brandIcon.test.ts
git commit -m "feat(brand): materialize full-color mark once for status-free tabs"
```

## Task 3: Point status-tinted icons at the monochrome mark

**Files:**
- Modify: `src/extension.ts`

- [ ] **Step 1: Add `MARK_SVG` beside `BRAND_SVG` (extension.ts ~line 334)**

```ts
/** The shipped karst mark. `HERE` is `dist/`, so the asset sits one level up. */
const BRAND_SVG = join(HERE, '..', 'media', 'karst.svg');
/** Monochrome silhouette of the same mark, tinted by the status glyph hue. */
const MARK_SVG = join(HERE, '..', 'media', 'karst-mark.svg');
```

- [ ] **Step 2: Switch the two `glyphIconPath` call sites to `MARK_SVG`** — the dashboard tab icon (`tabIconFor`, ~line 1349) and the terminal naming icon (~line 3270). `brandTabIcon` (~line 347) keeps `BRAND_SVG`.

- [ ] **Step 3: Verify no `glyphIconPath` call still feeds `BRAND_SVG`**

Run: `grep -n "glyphIconPath\|assetSvgPath" src/extension.ts`
Expected: `BRAND_SVG` appears ONLY in the `brandIconPaths` call; both `glyphIconPath` calls use `MARK_SVG`.

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/extension.ts
git commit -m "feat(brand): tint status icons from the monochrome mark silhouette"
```

## Task 4: Sidebar row marker → monochrome geometry

**Files:**
- Modify: `src/ui/sidebar/webview.html`
- Test: `src/ui/sidebar/webview.test.ts`

- [ ] **Step 1: Write the failing pins (sidebar/webview.test.ts)**

```ts
it('rows carry the approved #35 silhouette, not the old three-node graph', () => {
  expect(HTML).toContain('M 96 20');
  expect(HTML).toContain('M 151 42');
  expect(HTML).toContain('cx="106.5" cy="111.5" r="26.5"');
  expect(HTML).not.toContain('cx="6"');
  expect(HTML).not.toContain('7.6 7.6');
});
```

- [ ] **Step 2: Run — fails (old inline mark)**

Run: `npx vitest run src/ui/sidebar/webview.test.ts`
Expected: FAIL.

- [ ] **Step 3: Replace the inline `ic.mark` SVG (webview.html line ~289)** — monochrome silhouette, 13×13, `fill="currentColor"`, viewBox `0 0 215 215`

```html
mark:'<svg aria-hidden="true" width="13" height="13" viewBox="0 0 215 215" fill="currentColor"><path d="M 96 20 L 25 67 L 25 156 L 98 203 L 98 180 L 44 145 L 44 78 L 97 44 Z"/><path d="M 151 42 L 138 58 L 170 78 L 170 144 L 138 165 L 150 180 L 188 156 L 188 67 Z"/><circle cx="106.5" cy="111.5" r="26.5"/></svg>',
```

Also update the block comment above `.glyph` (~line 116) — the mark is now FILLED, not stroked: "the mark is drawn with `fill="currentColor"`".

- [ ] **Step 4: Run — GREEN**

Run: `npx vitest run src/ui/sidebar/webview.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ui/sidebar/webview.html src/ui/sidebar/webview.test.ts
git commit -m "feat(brand): sidebar row marker uses the approved #35 silhouette"
```

## Task 5: Getting-started splash gains the full-color mark

**Files:**
- Modify: `src/ui/gettingStarted/webview.html`
- Test: `src/ui/gettingStarted/webview.test.ts`

- [ ] **Step 1: Write the failing pins (gettingStarted/webview.test.ts)**

```ts
it('the splash header carries the approved full-color mark, not the old graph', () => {
  expect(HTML).toContain('M 96 20');
  expect(HTML).toContain('cx="106.5" cy="111.5" r="26.5"');
  expect(HTML).not.toContain('cx="6"');
  expect(HTML).not.toContain('7.6 7.6');
});
```

- [ ] **Step 2: Run — fails**

Run: `npx vitest run src/ui/gettingStarted/webview.test.ts`
Expected: FAIL (h1 has no mark).

- [ ] **Step 3: Add the mark to the h1 row (webview.html ~line 57)** — inline SVG with LOCAL gradient defs (self-contained webview; CSP forbids external assets). Wrap h1 in a flex row using `--k-*` tokens:

```html
<div class="gs-head">
  <svg aria-hidden="true" width="28" height="28" viewBox="0 0 215 215">
    <defs>
      <linearGradient id="gsLeft" x1="0.22" y1="0.12" x2="0.78" y2="0.92">
        <stop offset="0%" stop-color="#7D48E9"/><stop offset="43%" stop-color="#7D3CEE"/><stop offset="100%" stop-color="#4A71D7"/>
      </linearGradient>
      <linearGradient id="gsRight" x1="0.18" y1="0.10" x2="0.82" y2="0.90">
        <stop offset="0%" stop-color="#00B7C9"/><stop offset="55%" stop-color="#00AFC0"/><stop offset="100%" stop-color="#00B1C4"/>
      </linearGradient>
      <linearGradient id="gsCore" x1="0.20" y1="0.18" x2="0.82" y2="0.86">
        <stop offset="0%" stop-color="#6647DE"/><stop offset="48%" stop-color="#5660D9"/><stop offset="100%" stop-color="#3586D6"/>
      </linearGradient>
    </defs>
    <path d="M 96 20 L 25 67 L 25 156 L 98 203 L 98 180 L 44 145 L 44 78 L 97 44 Z" fill="url(#gsLeft)"/>
    <path d="M 151 42 L 138 58 L 170 78 L 170 144 L 138 165 L 150 180 L 188 156 L 188 67 Z" fill="url(#gsRight)"/>
    <circle cx="106.5" cy="111.5" r="26.5" fill="url(#gsCore)"/>
  </svg>
  <h1>Getting Started</h1>
</div>
```

CSS addition (in the file-local `<style>`, tokens only — UI-R04):

```css
.gs-head{display:flex;align-items:center;gap:var(--k-space-4);margin-bottom:var(--k-space-2)}
.gs-head h1{margin:0}
```

- [ ] **Step 4: Run — GREEN**

Run: `npx vitest run src/ui/gettingStarted/webview.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ui/gettingStarted/webview.html src/ui/gettingStarted/webview.test.ts
git commit -m "feat(brand): splash header carries the approved full-color mark"
```

## Task 6: Full verification

- [ ] **Step 1: Old geometry is gone from product surfaces**

Run: `grep -rn 'cx="6"\|cx="18"\|cy="18"\|7\.6 7\.6' src/ media/ | grep -v node_modules`
Expected: no output.

- [ ] **Step 2: Full suite + typecheck**

Run: `npm run typecheck && npm test`
Expected: all pass.

- [ ] **Step 3: Visual review on the main branded surfaces** (F5 Extension Dev Host):
  1. Activity bar icon — full-color #35 mark.
  2. Settings/usage/diffs/welcome tab icons — full-color mark.
  3. Terminal tab icon — monochrome silhouette tinted by the ticket's stage glyph; tab label keeps the stage color.
  4. Dashboard tab icon — monochrome silhouette tinted by the ticket glyph.
  5. Tickets sidebar rows — monochrome mark + status dot per row.
  6. Getting Started panel — full-color mark in the header.
  7. Dark AND light themes — contrast acceptable (approved colors).

- [ ] **Step 4: Final commit of the plan doc**

```bash
git add docs/superpowers/plans/2026-08-11-brand-35-logo-replacement.md
git commit -m "docs: brand #35 logo replacement plan"
```
