# Panel Tabs Show The Current Karst Mark Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure panel tabs always reflect the current Karst mark by content-addressing materialized brand and glyph SVG files under `<globalStorage>/icons/` with an 8-hex SHA-256 hash of the written bytes.

**Architecture:** Update `brandIconPaths` and `glyphIconPath` to compute a SHA-256 hash (first 8 hex characters) over the bytes actually written (`readFileSync(opts.assetSvgPath, 'utf8')` for brand; `tintSvg(source, hex)` for glyph). Materialize files as `icons/karst-brand-<hash>.svg` and `icons/karst-<glyph>-<hash>.svg`. Retain old files to avoid blanking tabs in older windows, maintain separate brand/glyph namespaces, and preserve no-write idempotence when source bytes are unchanged.

**Tech Stack:** TypeScript (ESM, Node.js `node:crypto`, `node:fs`, `node:path`), Vitest.

**Spec:** Ticket PANEL-TABS-SHOW-THE-CURRENT (P7 / D209); commits `4f58c7af1c`, `c58a06d59e`, `d8e3d623d7`; rule `[@ui:UI-R37]`.

## Global Constraints

- Content-address materialized files: `icons/karst-brand-<hash>.svg` and `icons/karst-<glyph>-<hash>.svg`, where `<hash>` is the first 8 hex digits of SHA-256 over the bytes actually written (raw source for brand; `tintSvg(source, hex)` for glyph).
- Idempotence: same source bytes -> same path and no write. Changed source or tint -> new path so VS Code repaints.
- `brandIconPaths` returns `{ light: file, dark: file }` using the same file for both theme entries.
- `glyphIconPath` returns `file` (one file per glyph).
- Do not delete older `karst-brand-*.svg` / `karst-<glyph>-*.svg` files.
- Keep the brand/glyph namespace separation (`karst-brand-` vs `karst-<glyph>-`).
- `tabIcon.test.ts` remains green; no panel host changes.
- UI-R37: Domain behavior preserved; no webview or logo asset changes.

---

### Task 1: Content-address glyph icons in `glyphIcon.ts`

**Files:**
- Modify: `src/ui/glyphIcon.ts`
- Test: `src/ui/glyphIcon.test.ts`

**Interfaces:**
- Produces: `glyphIconPath(glyph: Glyph, opts: { storageDir: string; assetSvgPath: string }): string` returning `<storageDir>/icons/karst-<glyph>-<hash>.svg`
- Consumes: `tintSvg(svg: string, hex: string): string` from `src/ui/glyphIcon.ts`, `glyphHex(glyph: Glyph): string` from `../model/glyphColor.js`, `createHash` from `node:crypto`.

- [x] **Step 1: Write failing tests for content-addressed `glyphIconPath`**

Edit `src/ui/glyphIcon.test.ts` to add tests for `glyphIconPath`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { tintSvg, glyphIconPath } from './glyphIcon.js';
import { glyphHex } from '../model/glyphColor.js';

const SRC = '<svg stroke="currentColor"><circle/></svg>';

describe('tintSvg', () => {
  it('replaces every currentColor with the hex', () => {
    expect(tintSvg(SRC, '#e35555')).toBe('<svg stroke="#e35555"><circle/></svg>');
  });
  it('is a no-op when there is no currentColor', () => {
    expect(tintSvg('<svg stroke="#000"/>', '#e35555')).toBe('<svg stroke="#000"/>');
  });
  it('leaves the source string unmutated (returns a new string)', () => {
    const src = SRC;
    tintSvg(src, '#38a86b');
    expect(src).toBe(SRC);
  });
});

describe('glyphIconPath', () => {
  let storageDir = '';
  let assetSvgPath = '';

  beforeEach(() => {
    storageDir = mkdtempSync(join(tmpdir(), 'karst-glyph-test-'));
    assetSvgPath = join(storageDir, 'mark.svg');
    writeFileSync(assetSvgPath, '<svg><path fill="currentColor"/></svg>', 'utf8');
  });

  it('materializes a content-addressed file under <storageDir>/icons', () => {
    const p = glyphIconPath('green', { storageDir, assetSvgPath });
    expect(dirname(p)).toBe(join(storageDir, 'icons'));
    const hex = glyphHex('green');
    const expectedContent = `<svg><path fill="${hex}"/></svg>`;
    const hash = createHash('sha256').update(expectedContent, 'utf8').digest('hex').slice(0, 8);
    expect(basename(p)).toBe(`karst-green-${hash}.svg`);
    expect(readFileSync(p, 'utf8')).toBe(expectedContent);
  });

  it('same source called twice -> same path, same bytes, no rewrite', () => {
    const first = glyphIconPath('blue', { storageDir, assetSvgPath });
    writeFileSync(first, '<svg data-sentinel="1"/>', 'utf8');
    const second = glyphIconPath('blue', { storageDir, assetSvgPath });
    expect(second).toBe(first);
    expect(readFileSync(second, 'utf8')).toBe('<svg data-sentinel="1"/>');
  });

  it('changed source yields a new path with matching hash', () => {
    const first = glyphIconPath('red', { storageDir, assetSvgPath });
    writeFileSync(assetSvgPath, '<svg><circle fill="currentColor"/></svg>', 'utf8');
    const second = glyphIconPath('red', { storageDir, assetSvgPath });
    expect(second).not.toBe(first);
    expect(readFileSync(first, 'utf8')).toContain('<path');
    expect(readFileSync(second, 'utf8')).toContain('<circle');
  });

  it('different glyphs yield distinct paths and files', () => {
    const blue = glyphIconPath('blue', { storageDir, assetSvgPath });
    const red = glyphIconPath('red', { storageDir, assetSvgPath });
    expect(blue).not.toBe(red);
    expect(readFileSync(blue, 'utf8')).toContain(glyphHex('blue'));
    expect(readFileSync(red, 'utf8')).toContain(glyphHex('red'));
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/ui/glyphIcon.test.ts`
Expected: FAIL because `glyphIconPath` returns `karst-green.svg` instead of `karst-green-<hash>.svg`.

- [x] **Step 3: Implement content-addressing in `src/ui/glyphIcon.ts`**

Update `src/ui/glyphIcon.ts`:

```ts
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Glyph } from '../model/glyph.js';
import { glyphHex } from '../model/glyphColor.js';

/** Bake a color into an SVG authored with `currentColor` (pure). */
export function tintSvg(svg: string, hex: string): string {
  return svg.replaceAll('currentColor', hex);
}

/**
 * Materialize the karst logo tinted for `glyph` into `<storageDir>/icons/` and
 * return its path (for `iconPath`). Content-addressed: the path embeds the
 * first 8 hex characters of the SHA-256 hash of the tinted SVG bytes.
 * Idempotent — the same tinted bytes yield the same path and skip rewriting.
 * `iconPath` renders a static image VS Code will not theme-tint, so the hue is
 * baked here rather than passed as a ThemeColor.
 */
export function glyphIconPath(
  glyph: Glyph,
  opts: { storageDir: string; assetSvgPath: string },
): string {
  const dir = join(opts.storageDir, 'icons');
  const src = readFileSync(opts.assetSvgPath, 'utf8');
  const tinted = tintSvg(src, glyphHex(glyph));
  const hash = createHash('sha256').update(tinted, 'utf8').digest('hex').slice(0, 8);
  const file = join(dir, `karst-${glyph}-${hash}.svg`);
  if (!existsSync(file)) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, tinted, 'utf8');
  }
  return file;
}
```

- [x] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/ui/glyphIcon.test.ts`
Expected: PASS (all tests pass).

- [x] **Step 5: Commit**

```bash
git add src/ui/glyphIcon.ts src/ui/glyphIcon.test.ts
git commit -m "fix(ui): content-address glyph icon files with 8-hex sha256"
```

---

### Task 2: Content-address brand icons in `brandIcon.ts` and update `brandIcon.test.ts`

**Files:**
- Modify: `src/ui/brandIcon.ts`
- Test: `src/ui/brandIcon.test.ts`

**Interfaces:**
- Produces: `brandIconPaths(opts: { storageDir: string; assetSvgPath: string }): BrandIconPaths` returning `{ light: file, dark: file }` where `file` is `<storageDir>/icons/karst-brand-<hash>.svg`
- Consumes: `createHash` from `node:crypto`, `glyphIconPath` from `src/ui/glyphIcon.ts`.

- [x] **Step 1: Write updated tests in `src/ui/brandIcon.test.ts`**

Update `src/ui/brandIcon.test.ts` with all required test cases from the specification:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename, dirname } from 'node:path';
import { brandIconPaths } from './brandIcon.js';
import { glyphIconPath } from './glyphIcon.js';

const ASSET = join(dirname(new URL(import.meta.url).pathname), '..', '..', 'media', 'karst.svg');

let storageDir = '';
beforeEach(() => {
  storageDir = mkdtempSync(join(tmpdir(), 'karst-brand-'));
});

const paths = (): { light: string; dark: string } =>
  brandIconPaths({ storageDir, assetSvgPath: ASSET });

describe('brandIconPaths', () => {
  it('materializes one status-free brand file under <storageDir>/icons', () => {
    const p = paths();
    expect(dirname(p.light)).toBe(join(storageDir, 'icons'));
    expect(p.light).toBe(p.dark);
    expect(readFileSync(p.light, 'utf8')).toContain('<svg');
  });

  // The activity-bar mark is monochrome: VS Code tints currentColor for the
  // active/inactive state, so one file serves both themes with no hue baked in.
  it('returns the approved mark for both themes, in currentColor', () => {
    const p = paths();
    const content = readFileSync(p.light, 'utf8');
    expect(content).toContain('M 96 20');
    expect(content).toContain('cx="106.5" cy="111.5" r="26.5"');
    expect(content).toContain('currentColor');
  });

  it('the two themes point at the SAME file (the mark needs no per-theme hue)', () => {
    const p = paths();
    expect(p.light).toBe(p.dark);
  });

  // The brand mark carries no status: it must never resolve to a file the
  // status ramp writes, or a Settings tab would read as an idle ticket.
  it('never collides with a status-tinted glyph icon', () => {
    const p = paths();
    const gray = glyphIconPath('gray', { storageDir, assetSvgPath: ASSET });
    expect([p.light, p.dark]).not.toContain(gray);
    expect(basename(p.light)).toMatch(/^karst-brand-[0-9a-f]{8}\.svg$/);
    expect(basename(gray)).toMatch(/^karst-gray-[0-9a-f]{8}\.svg$/);
  });

  it('same source called twice -> same path, same bytes, no rewrite', () => {
    const first = paths();
    writeFileSync(first.dark, '<svg data-kept="1"/>', 'utf8');
    const second = paths();
    expect(second).toEqual(first);
    expect(readFileSync(second.dark, 'utf8')).toBe('<svg data-kept="1"/>');
  });

  it('source changed between calls -> different path, bytes equal the new source', () => {
    const tmpSource = join(storageDir, 'dynamic.svg');
    writeFileSync(tmpSource, '<svg id="v1"/>', 'utf8');
    const first = brandIconPaths({ storageDir, assetSvgPath: tmpSource });
    expect(readFileSync(first.light, 'utf8')).toBe('<svg id="v1"/>');

    writeFileSync(tmpSource, '<svg id="v2"/>', 'utf8');
    const second = brandIconPaths({ storageDir, assetSvgPath: tmpSource });
    expect(second.light).not.toBe(first.light);
    expect(readFileSync(second.light, 'utf8')).toBe('<svg id="v2"/>');
    // Old file remains preserved (never deleted)
    expect(readFileSync(first.light, 'utf8')).toBe('<svg id="v1"/>');
  });

  it('light and dark entries are the same path', () => {
    const p = paths();
    expect(p.light).toBe(p.dark);
  });

  it('the brand path never equals a glyph path', () => {
    const p = paths();
    const gray = glyphIconPath('gray', { storageDir, assetSvgPath: ASSET });
    expect(p.light).not.toBe(gray);
    expect(p.dark).not.toBe(gray);
  });

  it('a glyph file contains the tinted mark, not the raw asset', () => {
    const raw = readFileSync(ASSET, 'utf8');
    expect(raw).toContain('currentColor');
    const gray = glyphIconPath('gray', { storageDir, assetSvgPath: ASSET });
    const content = readFileSync(gray, 'utf8');
    expect(content).not.toBe(raw);
    expect(content).toContain('#7f8896');
    expect(content).not.toContain('currentColor');
  });

  it('regression test with a temp source: write a file, call, rewrite it with different geometry, call again, assert path1 !== path2 and the second file contains the new geometry', () => {
    const tmpSource = join(storageDir, 'mark-source.svg');
    const geom1 = '<svg><path d="M 1 1"/></svg>';
    const geom2 = '<svg><path d="M 2 2"/></svg>';
    writeFileSync(tmpSource, geom1, 'utf8');

    const path1 = brandIconPaths({ storageDir, assetSvgPath: tmpSource });
    expect(readFileSync(path1.light, 'utf8')).toBe(geom1);

    writeFileSync(tmpSource, geom2, 'utf8');
    const path2 = brandIconPaths({ storageDir, assetSvgPath: tmpSource });

    expect(path1.light).not.toBe(path2.light);
    expect(readFileSync(path2.light, 'utf8')).toBe(geom2);
    expect(readFileSync(path1.light, 'utf8')).toBe(geom1);
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/ui/brandIcon.test.ts`
Expected: FAIL because `brandIconPaths` returns `karst-brand.svg` instead of `karst-brand-<hash>.svg`.

- [x] **Step 3: Implement content-addressing in `src/ui/brandIcon.ts`**

Update `src/ui/brandIcon.ts`:

```ts
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The karst mark for tabs that carry NO status — settings, usage, changes,
 * welcome, and a create-mode ticket form with no ticket bound yet. Those
 * panels have nothing for the status ramp to say, so the mark is rendered in
 * its approved brand treatment rather than in a glyph hue: a Settings tab
 * tinted `gray` would read as an idle ticket.
 *
 * One materialized file serves both entries of the `{light, dark}` pair that
 * `iconPath` takes: the mark is authored `fill="currentColor"`, and VS Code
 * tints it for the active theme, so no per-theme foreground is baked.
 */
export interface BrandIconPaths {
  light: string;
  dark: string;
}

/**
 * Materialize the karst mark into `<storageDir>/icons/` once and return both
 * theme paths (for `iconPath`). Content-addressed: the path embeds the first
 * 8 hex characters of the SHA-256 hash of the raw SVG bytes. Idempotent — the
 * same source bytes yield the same path and skip rewriting.
 */
export function brandIconPaths(opts: {
  storageDir: string;
  assetSvgPath: string;
}): BrandIconPaths {
  const dir = join(opts.storageDir, 'icons');
  const content = readFileSync(opts.assetSvgPath, 'utf8');
  const hash = createHash('sha256').update(content, 'utf8').digest('hex').slice(0, 8);
  const file = join(dir, `karst-brand-${hash}.svg`);
  if (!existsSync(file)) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, content, 'utf8');
  }
  return { light: file, dark: file };
}
```

- [x] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/ui/brandIcon.test.ts`
Expected: PASS (all 10 tests pass).

- [x] **Step 5: Commit**

```bash
git add src/ui/brandIcon.ts src/ui/brandIcon.test.ts
git commit -m "fix(ui): content-address brand icon files with 8-hex sha256"
```

---

### Task 3: Full suite verification and typecheck

**Files:**
- Test: `src/ui/brandIcon.test.ts`
- Test: `src/ui/glyphIcon.test.ts`
- Test: `src/ui/brandAssets.test.ts`
- Test: `src/ui/tabIcon.test.ts`
- Test: `src/ui/terminalNaming.test.ts`

**Interfaces:**
- Verifies that all tab icon, brand asset, and terminal naming consumers operate correctly with content-addressed files.

- [x] **Step 1: Run typecheck across the project**

Run: `npm run typecheck`
Expected: Clean exit (0 errors).

- [x] **Step 2: Run all related UI unit tests**

Run: `npx vitest run src/ui/brandIcon.test.ts src/ui/glyphIcon.test.ts src/ui/brandAssets.test.ts src/ui/tabIcon.test.ts src/ui/terminalNaming.test.ts`
Expected: PASS (all tests pass).

- [x] **Step 3: Verify git status is clean**

Run: `git status`
Expected: Working tree clean with all commits recorded.
