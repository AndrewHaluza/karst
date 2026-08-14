# Scope Stage Color → Cool Gray / Steel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Scope stage's purple with the approved cool-gray/steel foreground+background pair in the shared stage palette, and apply that pair everywhere stage identity drives a fill, so Scope reads as a preparatory stage before Implement's saturated indigo.

**Architecture:** The shared stage palette (`src/model/stagePalette.ts`) is the single source of stage identity; it is emitted as `--stage-*`/`--stg-*` CSS tokens and injected into every webview through `src/model/palette.ts`'s `/*KARST_PALETTE*/` marker. The palette today ships only a foreground per stage — backgrounds are derived at the consumer via `color-mix`. This change adds an **optional** per-stage background pair to the shared palette (set only for `scope`), emits `--stage-scope-bg` + a `--stg-bg` handle, and updates the two fill consumers (the sidebar stage chip and the dashboard rail's passed/running segments) to prefer `var(--stg-bg, …)` while keeping the existing `color-mix` wash as the fallback for every other stage. No screen-local palette, no status/feedback tokens, no rail geometry/typography/spacing changes.

**Tech Stack:** TypeScript (vitest, `tsc --noEmit`), plain CSS custom properties, self-contained `webview.html` documents.

## Global Constraints

- Scope dark theme: foreground `#8FA3B8`, background `#29343D`.
- Scope light theme: foreground `#526A80`, background `#EAEDF0`.
- Only Scope changes. Implement, UAT, Review, Ship, Done (and the internal `fix`) colors are unchanged — same hexes, same `color-mix` wash appearance.
- Scope must remain a **stage identity** color: keep it on the `--stage-*`/`--stg-*` tokens. Do NOT map it to `--k-*` workflow-status or feedback tokens (UI-R06).
- No duplicate/screen-local Scope palette: the only Scope color literals live in the shared `stagePalette.ts` (plus the illustrative design catalog, which is a doc). Webviews must not declare their own Scope hexes.
- Preserve rail geometry, typography, spacing, stage sequence/names (`STAGE_KEYS`), status semantics, and interaction behavior. Status classes (`.needs`/`.failed`/`.skipped`/`.sel`) are untouched — status still outranks stage.
- High-contrast VS Code themes fall through to the dark values (existing behavior in `stagePalette.ts`); the dark pair must clear WCAG AA ≥ 4.5:1 (UI-R29).
- Existing design-system/UI tests must pass; `npm run typecheck` must pass.
- UI-R34: mirrored TS→HTML constants are behavior, not styling — do not touch them.

---

### Task 1: Shared stage palette — Scope steel pair and background tokens

**Files:**
- Modify: `src/model/stagePalette.ts` (interface `StageColor` at line 24, `STAGE_COLORS` at line 34, `stagePaletteCss` at line 83)
- Test: `src/model/stagePalette.test.ts`

**Interfaces:**
- Consumes: `STAGE_KEYS` and `StageKey` from `src/model/types.js` (unchanged — sequence/names preserved).
- Produces:
  - `interface StageColor { dark: string; light: string; bg?: StageColor }` — `bg` is the optional per-theme background pair.
  - `STAGE_COLORS.scope` = `{ dark: '#8FA3B8', light: '#526A80', bg: { dark: '#29343D', light: '#EAEDF0' } }`.
  - `stagePaletteCss()` emits, for a stage with `bg` only: `--stage-<key>-bg:<dark>` inside `:root`, `--stage-<key>-bg:<light>` inside `body.vscode-light`, and `--stg-bg:var(--stage-<key>-bg)` on the `.stg-<key>` class. Stages without `bg` emit no `-bg` token and no `--stg-bg`.

- [ ] **Step 1: Write the failing tests**

Append a WCAG contrast helper after the imports in `src/model/stagePalette.test.ts`:

```ts
/** WCAG relative-luminance contrast ratio between two `#rrggbb` hexes. */
function contrastRatio(hexA: string, hexB: string): number {
  const luminance = (hex: string): number => {
    const channels = hex
      .slice(1)
      .match(/.{2}/g)!
      .map((pair) => parseInt(pair, 16) / 255);
    const linear = channels.map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * linear[0]! + 0.7152 * linear[1]! + 0.0722 * linear[2]!;
  };
  const [hi, lo] = [luminance(hexA), luminance(hexB)].sort((a, b) => b - a);
  return (hi + 0.05) / (lo + 0.05);
}
```

Insert a new `describe` block right after the existing `describe('STAGE_COLORS', …)` block (which ends at line 30):

```ts
describe('Scope steel palette (869ej2cfz)', () => {
  it('uses the approved cool-gray/steel pair in both themes', () => {
    expect(STAGE_COLORS.scope).toMatchObject({
      dark: '#8FA3B8',
      light: '#526A80',
      bg: { dark: '#29343D', light: '#EAEDF0' },
    });
  });

  it('leaves every other stage colour untouched — only Scope changes', () => {
    expect(STAGE_COLORS.impl).toEqual({ dark: '#7f7bf5', light: '#4f46e5' });
    expect(STAGE_COLORS.uat).toEqual({ dark: '#d18616', light: '#b45309' });
    expect(STAGE_COLORS.review).toEqual({ dark: '#2ea8b5', light: '#0e7490' });
    expect(STAGE_COLORS.fix).toEqual({ dark: '#f14c4c', light: '#c93636' });
    expect(STAGE_COLORS.ship).toEqual({ dark: '#d162c4', light: '#bf3989' });
    expect(STAGE_COLORS.done).toEqual({ dark: '#4bb64b', light: '#1a7f37' });
  });

  it('clears WCAG AA (>= 4.5:1) for the Scope label on its own fill in both themes', () => {
    // The dark pair also serves high-contrast themes (stagePalette.ts comment).
    expect(contrastRatio(STAGE_COLORS.scope.dark, STAGE_COLORS.scope.bg!.dark)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(STAGE_COLORS.scope.light, STAGE_COLORS.scope.bg!.light)).toBeGreaterThanOrEqual(4.5);
  });
});
```

Add two tests inside the existing `describe('stagePaletteCss', …)` block (the shared `const css = stagePaletteCss();` at line 44 is reused):

```ts
  it('emits the Scope background token per theme and a --stg-bg handle', () => {
    expect(css).toContain('--stage-scope-bg:#29343D');
    expect(css).toMatch(
      /\.stg-scope\{color:var\(--stage-scope\);--stg-color:var\(--stage-scope\);--stg-bg:var\(--stage-scope-bg\)\}/,
    );
    const light = css.slice(css.indexOf('body.vscode-light'));
    expect(light).toContain('--stage-scope-bg:#EAEDF0');
  });

  it('gives no other stage a background token — Scope is the only approved pair', () => {
    for (const key of STAGE_KEYS) {
      if (key === 'scope') continue;
      expect(css).not.toContain(`--stage-${key}-bg:`);
      expect(css).not.toContain(`.stg-${key}{color:var(--stage-${key});--stg-color:var(--stage-${key});--stg-bg`);
    }
  });
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npx vitest run src/model/stagePalette.test.ts`

Expected: FAIL. `STAGE_COLORS.scope` is still `{ dark: '#a371f7', light: '#8250df' }` (no `bg`), and `stagePaletteCss()` emits no `--stage-scope-bg`/`--stg-bg`. The contrast and "other stages unchanged" assertions fail too.

- [ ] **Step 3: Implement the shared palette**

In `src/model/stagePalette.ts`:

1. Extend the interface (line 24–27):

```ts
/** One stage's color in each theme. */
export interface StageColor {
  dark: string;
  light: string;
  /**
   * Optional per-theme background. Only stages with an approved solid pair set
   * it — `scope` is the first (a steel fill). Consumers fall back to a
   * `color-mix` wash of the foreground when absent, which is every other stage.
   */
  bg?: StageColor;
}
```

2. Replace the `scope` entry in `STAGE_COLORS` (line 35) and add a comment:

```ts
  // Cool gray / steel — reads as the preparatory, definition stage before
  // Implement's saturated indigo (869ej2cfz). The light foreground is
  // deliberately darker than the dark-theme one so the small rail label clears
  // the pale steel fill.
  scope: { dark: '#8FA3B8', light: '#526A80', bg: { dark: '#29343D', light: '#EAEDF0' } },
```

3. Replace the body of `stagePaletteCss` (lines 83–101) with:

```ts
export function stagePaletteCss(): string {
  const decls = (pick: (c: StageColor) => string): string =>
    entries()
      .map(([key, color]) => `--stage-${key}:${pick(color)};`)
      .join('');
  // A stage with an approved background pair emits a `--stage-<key>-bg` token;
  // stages without one emit nothing and consumers keep the color-mix wash.
  const withBg = entries().filter(
    (e): e is [string, StageColor & { bg: StageColor }] => e[1].bg !== undefined,
  );
  const bgDecls = (pick: (c: StageColor) => string): string =>
    withBg.map(([key, color]) => `--stage-${key}-bg:${pick(color.bg)};`).join('');
  // Each class sets `color` (so text/currentColor read the stage hue),
  // `--stg-color` (a stable handle on the hue) and, when a background exists,
  // `--stg-bg` (a stable handle on the fill). A filled node overrides its own
  // `color` to knock the glyph out against the fill, which would make
  // `currentColor` resolve to the knockout color — so fills reference
  // `--stg-color`/`--stg-bg`, which the color override cannot disturb.
  const classes = entries()
    .map(([key, color]) => {
      const bg = color.bg !== undefined ? `;--stg-bg:var(--stage-${key}-bg)` : '';
      return `.stg-${key}{color:var(--stage-${key});--stg-color:var(--stage-${key})${bg}}`;
    })
    .join('');
  return (
    `:root{${decls((c) => c.dark)}${bgDecls((c) => c.dark)}}` +
    `body.vscode-light{${decls((c) => c.light)}${bgDecls((c) => c.light)}}` +
    classes
  );
}
```

4. Update the module-header comment's line "Each stage carries a dark and a light value, both chosen to clear text contrast on the washed-out chip fill (`color-mix(currentColor 14–18%, transparent)`)." to add: "`scope` additionally carries an approved background pair (`bg`) that consumers fill with instead of the wash; every other stage still washes."

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `npx vitest run src/model/stagePalette.test.ts`

Expected: PASS. The existing tests (distinct hues, token/class per stage, `--stg-color` handle, light override, fallback) still pass because they use substring containment; the new Scope tests pass.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`

Expected: PASS (the `StageColor & { bg: StageColor }` type-guard predicate satisfies `noUncheckedIndexedAccess`).

- [ ] **Step 6: Commit**

```bash
git add src/model/stagePalette.ts src/model/stagePalette.test.ts
git commit -m "feat(ui): scope stage color to cool gray / steel in the shared palette"
```

---

### Task 2: Apply the pair in the two stage-identity fill consumers

The sidebar chip and the dashboard rail are the only two places where stage identity is rendered as a fill derived from the shared token. Both change one declaration each, swapping the `color-mix` wash for `var(--stg-bg, <same wash>)` — Scope resolves to its approved solid fill, every other stage (no `--stg-bg`) resolves to the identical wash as before.

**Files:**
- Modify: `src/ui/sidebar/webview.html:156-158` (`.stage` chip background)
- Modify: `src/ui/dashboard/webview.html:403-404` (`.track .seg.passed`) and `:412-413` (`.track .seg.running`)
- Test: `src/ui/sidebar/webview.test.ts`
- Test: `src/ui/dashboard/webview.test.ts`

**Interfaces:**
- Consumes: `--stg-bg` (from Task 1's `stagePaletteCss`, injected via `paletteCss()` at the trailing `/*KARST_PALETTE*/` marker).
- Produces: nothing new for later tasks — the fallback pattern `var(--stg-bg, …)` is what later visual verification exercises.

- [ ] **Step 1: Write the failing sidebar test**

Add this test to the `describe('sidebar webview.html', …)` block in `src/ui/sidebar/webview.test.ts` (after the existing `renders the stage chip…` test):

```ts
  it('fills a stage chip with its approved background pair, falling back to the wash (869ej2cfz)', () => {
    // Only Scope ships a --stg-bg today; every other stage keeps the colour-mix
    // wash, so their chip appearance is unchanged.
    expect(HTML).toMatch(
      /\.stage\{[\s\S]*?background:var\(--stg-bg,color-mix\(in srgb, currentColor 16%, transparent\)\)\}/,
    );
  });
```

- [ ] **Step 2: Run the sidebar test and confirm it fails**

Run: `npx vitest run src/ui/sidebar/webview.test.ts`

Expected: FAIL on the new test — the `.stage` rule still reads `background:color-mix(in srgb, currentColor 16%, transparent)` with no `var(--stg-bg,…)`.

- [ ] **Step 3: Update the sidebar chip fill**

In `src/ui/sidebar/webview.html`, change line 158 from:

```css
    background:color-mix(in srgb, currentColor 16%, transparent)}
```

to:

```css
    background:var(--stg-bg,color-mix(in srgb, currentColor 16%, transparent))}
```

Update the comment at lines 152–155 to note: the chip's fill prefers the stage's approved background pair (`--stg-bg`, currently only Scope) and falls back to the washed-out foreground for every other stage.

- [ ] **Step 4: Run the sidebar test and confirm it passes**

Run: `npx vitest run src/ui/sidebar/webview.test.ts`

Expected: PASS.

- [ ] **Step 5: Write the failing dashboard tests**

Add this test to `src/ui/dashboard/webview.test.ts` (inside the same `describe` that owns the `.track .seg` structural tests, e.g. after the `lets the stage palette win the hue…` test at line 516):

```ts
  it('fills travelled Scope segments with their approved background, else the wash (869ej2cfz)', () => {
    // passed and running are the two fills that paint STAGE identity; the status
    // overrides (needs/failed/skipped/sel) must stay untouched.
    expect(HTML).toMatch(
      /\.track \.seg\.passed\{background:var\(--stg-bg,color-mix\(in srgb,var\(--stg-color,var\(--k-pending\)\) 20%,transparent\)\);/,
    );
    expect(HTML).toMatch(
      /\.track \.seg\.running\{background:var\(--stg-bg,color-mix\(in srgb,var\(--stg-color,var\(--k-pending\)\) 34%,transparent\)\);/,
    );
  });
```

- [ ] **Step 6: Run the dashboard test and confirm it fails**

Run: `npx vitest run src/ui/dashboard/webview.test.ts`

Expected: FAIL on the new test — the `.passed`/`.running` rules still start with `background:color-mix(`.

- [ ] **Step 7: Update the dashboard rail fills**

In `src/ui/dashboard/webview.html`, change line 403 from:

```css
  .track .seg.passed{background:color-mix(in srgb,var(--stg-color,var(--k-pending)) 20%,transparent);
```

to:

```css
  .track .seg.passed{background:var(--stg-bg,color-mix(in srgb,var(--stg-color,var(--k-pending)) 20%,transparent));
```

and line 412 from:

```css
  .track .seg.running{background:color-mix(in srgb,var(--stg-color,var(--k-pending)) 34%,transparent);
```

to:

```css
  .track .seg.running{background:var(--stg-bg,color-mix(in srgb,var(--stg-color,var(--k-pending)) 34%,transparent));
```

Add a short comment before line 403 (inside the `/* Travelled segments… */` block near line 398): "A stage with an approved background pair (Scope) fills with `--stg-bg`; every other stage keeps the `color-mix` wash, so their appearance is unchanged."

- [ ] **Step 8: Run the dashboard test and confirm it passes**

Run: `npx vitest run src/ui/dashboard/webview.test.ts`

Expected: PASS.

- [ ] **Step 9: Run both webview suites and typecheck**

Run: `npx vitest run src/ui/sidebar/webview.test.ts src/ui/dashboard/webview.test.ts && npm run typecheck`

Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add src/ui/sidebar/webview.html src/ui/sidebar/webview.test.ts src/ui/dashboard/webview.html src/ui/dashboard/webview.test.ts
git commit -m "feat(ui): apply scope steel pair in sidebar chip and dashboard rail"
```

---

### Task 3: Design-system catalog reflects the approved Scope palette

The rendered design-system reference (`docs/ui/KARST-UI-CATALOG.html`) documents the stage tokens and the rail composition. Its illustrative Scope values still show the old purple; update them to the approved steel pair so the catalog stays truthful ("rail remains visually consistent with the Karst design system").

**Files:**
- Modify: `docs/ui/KARST-UI-CATALOG.html` (dark tokens at lines 46–47, light override at line 388)

**Interfaces:**
- Consumes: nothing (static document).
- Produces: the verified reference the visual checks in Task 4 compare against.

- [ ] **Step 1: Update the dark-theme Scope tokens**

In `docs/ui/KARST-UI-CATALOG.html`, change lines 46–47 from:

```css
  --stage-scope:#b77bff;
  --stage-scope-bg:#392e4a;
```

to:

```css
  --stage-scope:#8FA3B8;
  --stage-scope-bg:#29343D;
```

- [ ] **Step 2: Update the light-theme Scope tokens**

In the `body.light` override (line 388), change:

```css
  --stage-scope-bg:color-mix(in srgb,var(--stage-scope) 12%,var(--k-surface));
```

to:

```css
  --stage-scope:#526A80;--stage-scope-bg:#EAEDF0;
```

Leave the other five `--stage-*-bg` `color-mix` lines (389–393) untouched.

- [ ] **Step 3: Verify visually in both themes**

Open `docs/ui/KARST-UI-CATALOG.html` in a browser. Click the `Light theme` toolbar button to toggle.

Expected: the Scope segment of the stage rail reads steel gray (`#8FA3B8` text on `#29343D` in dark; `#526A80` on `#EAEDF0` in light), matching the attached `karst-scope-steel-dark-light.html` reference. Implement, UAT, Review, Ship, and Done segments are unchanged.

- [ ] **Step 4: Commit**

```bash
git add docs/ui/KARST-UI-CATALOG.html
git commit -m "docs(ui): reflect scope steel palette in the design catalog"
```

---

### Task 4: Full verification pass

**Files:**
- Verify only — no code changes.

**Interfaces:**
- Consumes: Tasks 1–3.

- [ ] **Step 1: Run the full unit suite**

Run: `npm run test:unit`

Expected: PASS, including `src/model/stagePalette.test.ts`, `src/ui/sidebar/webview.test.ts`, `src/ui/dashboard/webview.test.ts`, and the design-system tests (`src/ui/designSystem.test.ts`, `src/model/designTokens.test.ts`, `src/model/designComponents.test.ts`, `src/model/designRuntime.test.ts`, `src/ui/webviewCsp.test.ts`).

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`

Expected: PASS.

- [ ] **Step 3: Prove no duplicate/screen-local Scope palette**

Run:

```bash
rg -n --glob '*.ts' --glob '*.html' '8FA3B8|29343D|526A80|EAEDF0|a371f7|8250df' src docs/ui/KARST-UI-CATALOG.html
```

Expected: matches appear ONLY in `src/model/stagePalette.ts` (the shared source), its test `src/model/stagePalette.test.ts`, the consumer CSS in the two webview HTMLs (only the `var(--stg-bg,…)` references — no literal Scope hexes), and `docs/ui/KARST-UI-CATALOG.html` (the illustrative doc). No webview declares a Scope hex literal. (`a371f7`/`8250df` appear only in `src/ui/dashboard/webview.test.ts` as a "must NOT match" guard — leave that untouched.)

- [ ] **Step 4: Manual theme verification (dark, light, high-contrast)**

F5 in VS Code (Extension Development Host) and open a ticket dashboard with a Scope stage:

1. **Dark** (e.g. Default Dark Modern): Scope rail segment fills `#29343D` with `#8FA3B8` label; sidebar Scope chip matches; the label is legible (≈4.9:1).
2. **Light** (e.g. Default Light Modern): Scope segment fills `#EAEDF0` with `#526A80` label; chip matches; label legible (≈4.8:1).
3. **High-contrast** (e.g. High Contrast): Scope uses the dark pair (high-contrast falls through to dark values); label legible on the fill; the rail still reads as a chevron sequence with all six stages in order Scope → Impl → UAT → Review → Ship → Done.
4. Confirm a travelled Scope segment (`passed`) and a running Scope segment (`running`) both use the approved fill; a Scope segment that `needs` a human or `failed` still shows the amber/hatched status treatment (status outranks stage).

No commit — this task verifies and closes the work.

---

## Self-Review

**1. Spec coverage.**
- "Update the shared stage palette source for Scope" → Task 1 (`stagePalette.ts`).
- "Apply the new Scope foreground/background pair anywhere stage identity comes from the shared palette" → Task 2 (the only two fill consumers of stage identity: sidebar chip + dashboard passed/running segments).
- "Only Scope changes. Do not retune the other stage colors" → Task 1 pins every other stage's exact hexes; Task 2's fallback keeps their `color-mix` wash byte-identical.
- "Scope must remain a stage identity color, not status/feedback tokens" → stays on `--stage-scope`/`--stg-bg`; Task 4 Step 3 grep proves no `--k-*` mapping.
- "No duplicate/screen-local Scope palette" → Task 4 Step 3 grep.
- "Preserve sequence/names/geometry/status semantics" → `STAGE_KEYS` untouched; status classes untouched; only two `background:` declarations change.
- "Dark #8FA3B8/#29343D, light #526A80/#EAEDF0" → Task 1 tests pin both.
- "Verify dark, light, high-contrast" → Task 1 contrast test (dark pair serves high-contrast) + Task 4 Step 4 manual.
- "Existing design-system/UI tests pass; typecheck passes" → Task 4 Steps 1–2.
- "Rail remains visually consistent" → Task 3 catalog + Task 4 Step 4.

**2. Placeholder scan.** No TBD/TODO; every step carries concrete code or a concrete command + expected result.

**3. Type consistency.** `StageColor.bg?: StageColor`, `STAGE_COLORS.scope.bg`, `--stage-scope-bg`, and `--stg-bg` are named identically across Task 1 (emission), Task 2 (consumption), and the tests. The `withBg` type guard and `color.bg` references agree.
