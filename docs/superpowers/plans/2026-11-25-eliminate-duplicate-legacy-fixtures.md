# Eliminate Duplicate Legacy Fixture Pages Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The fixture writer writes only the registered variant pages, and each visual spec opens a page by its variant id.

**Architecture:** `tests/visual/buildFixture.ts#writeFixtures` writes a second, legacy set of pages (`<view>.html`, `dashboard-<scenario>.html`, `settings-<scenario>.html`) next to the variant pages (`<view>--<variant>.html`). The legacy pages hold the same corpora as registered variants. This plan removes the legacy writes, removes the `scenario` option of `gotoView`, and makes `variant` a required option. A new map `DEFAULT_VARIANT` gives the variant that a spec opens for the default page of a view.

**Tech Stack:** TypeScript (ESM, `.js` import suffix), Playwright (`tests/visual/*.visual.ts`, `*.layout.ts`), vitest (`tests/visual/*.test.ts`).

**Spec:** the ticket ELIMINATE-DUPLICATE-LEGACY prompt (planned in P74 as D779). Design constraints: `@ui:VISUAL-VARIANTS`, `@ui:FIXTURE-SCOPE`, `@ui:UI-R57` (all in `docs/ui/VISUAL-COVERAGE.md`).

## Global Constraints

- Legacy page to variant page map (each pair has the same corpus, so no baseline and no ratchet changes):
  - `dashboard-pending.html` (the default `gotoView('dashboard')`) -> `dashboard--pending.html` (variant `pending`)
  - `dashboard-running.html` -> `dashboard--populated.html` (variant `populated`)
  - `dashboard-<s>.html` for `s` in passed, failed, waiting, exhausted -> `dashboard--<s>.html`
  - `settings.html` (MINIMAL corpus) -> `settings--minimal.html` (variant `minimal`). Do NOT use `populated` for the default settings page: it uses `REALISTIC_SETTINGS` and shifts `FOCUS_COUNT_RATCHET.settings` and `CONTRAST_RATCHET`.
  - `settings-realistic.html` -> `settings--populated.html` (variant `populated`)
  - `settings-empty.html` -> `settings--empty.html` (no caller today)
  - `<view>.html` for every other view -> `<view>--populated.html` (variant `populated`, corpus `getCorpus(view)`)
- Every default variant declares `ALL_THEMES` (`dark`, `light`, `hc`), so every theme has the page.
- Do not edit a baseline PNG, `layout-known-failures.json`, `visual-known-failures.json` or the layout ledger.
- Do not run the full vitest suite (karst runs the gates). Run the changed test files, `npm run -s typecheck` and `npm run -s typecheck:visual`.
- Do not use `sed -i`. Use the file-edit tool.

## File Structure

- Create `tests/visual/defaultVariant.ts`: the `DEFAULT_VARIANT` map (one responsibility, so `variants.ts`, already 1600+ lines, does not grow).
- Create `tests/visual/defaultVariant.test.ts`: the map names a registered variant on every theme.
- Modify `tests/visual/buildFixture.ts`: remove the legacy writes.
- Modify `tests/visual/corpora.ts`: remove `SETTINGS_SCENARIOS` (no reader after the change).
- Modify `tests/visual/fixtures.ts`: remove the `scenario` fallback; `variant` is required.
- Modify callers: `layout.layout.ts`, `status.visual.ts`, `stagePalette.visual.ts`, `focus.visual.ts`, `a11y.visual.ts`, `contentCap.visual.ts`.
- Modify tests: `fixtureThemes.test.ts`, `fixtureScope.test.ts`.
- Modify `docs/ui/responsive-audit/capture.ts`: read the variant pages.
- Modify `docs/ui/VISUAL-COVERAGE.md` block `@ui:VISUAL-VARIANTS`: one sentence.

---

### Task 1: DEFAULT_VARIANT map

**Files:**
- Create: `tests/visual/defaultVariant.ts`
- Test: `tests/visual/defaultVariant.test.ts`

**Interfaces:**
- Produces: `export const DEFAULT_VARIANT: Readonly<Record<ViewId, string>>` in `tests/visual/defaultVariant.ts`.

- [ ] **Step 1: Write the failing test** `tests/visual/defaultVariant.test.ts`

```ts
import { describe, expect, it } from 'vitest';
import { ALL_VIEWS } from './corpora.js';
import { DEFAULT_VARIANT } from './defaultVariant.js';
import { THEME_IDS } from './themes.js';
import { VARIANTS } from './variants.js';

describe('DEFAULT_VARIANT (ui:VISUAL-VARIANTS)', () => {
  it('names a registered variant of each view that every fixture theme records', () => {
    for (const view of ALL_VIEWS) {
      const v = VARIANTS[view].find((x) => x.id === DEFAULT_VARIANT[view]);
      expect(v, `${view}/${DEFAULT_VARIANT[view]}`).toBeDefined();
      expect(v!.themes).toEqual(expect.arrayContaining([...THEME_IDS]));
    }
  });

  it('keeps the ratchet pages: dashboard pending and settings minimal', () => {
    expect(DEFAULT_VARIANT.dashboard).toBe('pending');
    expect(DEFAULT_VARIANT.settings).toBe('minimal');
  });
});
```

- [ ] **Step 2: Run it.** `npx vitest run tests/visual/defaultVariant.test.ts`. Expected: FAIL, cannot resolve `./defaultVariant.js`.

- [ ] **Step 3: Write** `tests/visual/defaultVariant.ts`

```ts
import type { ViewId } from '../../src/model/webviewChains.js';

/**
 * The registered variant (tests/visual/variants.ts) that a spec opens when it checks the default page of a view,
 * not a named state (@ui:VISUAL-VARIANTS). Dashboard `pending` and settings `minimal` hold the corpora that
 * FOCUS_COUNT_RATCHET and CONTRAST_RATCHET were measured on; settings `populated` uses REALISTIC_SETTINGS.
 */
export const DEFAULT_VARIANT: Readonly<Record<ViewId, string>> = {
  dashboard: 'pending',
  usage: 'populated',
  resources: 'populated',
  serverLogs: 'populated',
  sidebar: 'populated',
  diffs: 'populated',
  settings: 'minimal',
  ticketForm: 'populated',
  gettingStarted: 'populated',
};
```

Use the same `ViewId` import that `tests/visual/corpora.ts` uses (check its import line; copy it).

- [ ] **Step 4: Run it.** Same command. Expected: PASS.

- [ ] **Step 5: Commit.** `git add tests/visual/defaultVariant.ts tests/visual/defaultVariant.test.ts && git commit -m "test: add DEFAULT_VARIANT map for the default fixture page of each view"`

### Task 2: Write only variant pages, open only by variant id

**Files:**
- Modify: `tests/visual/buildFixture.ts:184-224`, `tests/visual/corpora.ts:274-285`, `tests/visual/fixtures.ts:6,24-29,33,80-89`
- Modify callers: `tests/visual/layout.layout.ts:31,42`, `tests/visual/status.visual.ts:26`, `tests/visual/stagePalette.visual.ts:44,53`, `tests/visual/focus.visual.ts:175`, `tests/visual/a11y.visual.ts:174,328,372,390,440`, `tests/visual/contentCap.visual.ts:44,52,59,105`
- Modify: `docs/ui/responsive-audit/capture.ts:24-41`, `docs/ui/VISUAL-COVERAGE.md` (`@ui:VISUAL-VARIANTS`)
- Test: `tests/visual/fixtureThemes.test.ts:34`, `tests/visual/fixtureScope.test.ts:6`

**Interfaces:**
- Consumes: `DEFAULT_VARIANT` (Task 1), `fixtureFile(view, variantId)` from `variants.ts` (returns `` `${view}--${variantId}.html` ``).
- Produces: `GotoOpts = { variant: string; route?: SettingsRoute }`; `gotoView(view: ViewId, opts: GotoOpts): Promise<Page>`.

- [ ] **Step 1: Write the failing tests.** In `fixtureThemes.test.ts`, replace the scoped-write test body assertions:

```ts
        const dark = readdirSync(join(scoped, 'dark'));
        expect(dark).toContain(fixtureFile('settings', 'minimal'));
        expect(dark).toContain(fixtureFile('settings', 'populated'));
        expect(dark.every((file) => file.startsWith('settings--'))).toBe(true);
        expect(existsSync(join(scoped, 'catalog.html'))).toBe(true);
```

Add one test in the same `describe('writeFixtures')`:

```ts
    it('writes only registered variant pages', () => {
      writeFixtures(out);
      for (const theme of THEME_IDS) {
        const legacy = readdirSync(join(out, theme)).filter((file) => !file.includes('--'));
        expect(legacy, theme).toEqual([]);
      }
    });
```

Import `THEME_IDS` from `./themes.js`. In `fixtureScope.test.ts:6`, set `const path = '/dark/dashboard--pending.html';`.

- [ ] **Step 2: Run them.** `npx vitest run tests/visual/fixtureThemes.test.ts tests/visual/fixtureScope.test.ts`. Expected: the two `fixtureThemes` tests FAIL (legacy `settings.html`, `settings-realistic.html` exist). `fixtureScope` passes (path is only a string).

- [ ] **Step 3: Remove the legacy writes.** In `buildFixture.ts#writeFixtures`, the loop body over `views` keeps only the variant loop:

```ts
    for (const view of views) {
      // One page per registered variant (ui:UI-R57), only for themes the variant declares.
      for (const v of VARIANTS[view]) {
        if (!v.themes.some((project) => fixtureThemeOf(project) === theme)) continue;
        const html = buildFixture(view, theme, v.corpus().messages, v.corpus().viewState);
        writeFileSync(join(themeDir, fixtureFile(view, v.id)), html, 'utf8');
      }
    }
```

Update the JSDoc above `resetFixtureDir`: "Structure: `<outDir>/<theme>/<view>--<variant>.html` for each registered variant and each theme it declares, plus a copy of the catalog page at `<outDir>/catalog.html`." Remove the dashboard-scenario sentence. Remove `getCorpus`, `dashboardCorpora` and `SETTINGS_SCENARIOS` from the `./corpora.js` import if nothing else in the file uses them (keep `ALL_VIEWS`).

- [ ] **Step 4: Remove `SETTINGS_SCENARIOS`** and its JSDoc from `corpora.ts`. Remove `EMPTY_SETTINGS`/`REALISTIC_SETTINGS` from its import when no other line in `corpora.ts` uses them.

- [ ] **Step 5: Make `variant` required in `fixtures.ts`.**

```ts
interface GotoOpts {
  /** A registered variant id (tests/visual/variants.ts); DEFAULT_VARIANT gives the default page of a view. */
  variant: string;
  route?: SettingsRoute;
}
```

`gotoView: (view: ViewId, opts: GotoOpts) => Promise<Page>;` and in the fixture body:

```ts
    const goto = async (view: ViewId, opts: GotoOpts) => {
      if (view === 'dashboard') await page.clock.setFixedTime(DASHBOARD_NOW);
      const path = `/${theme}/${fixtureFile(view, opts.variant)}`;
```

Replace `opts?.route` with `opts.route`. Update the header comment line 6: `gotoView(view, { variant })` navigates to `/<theme>/<view>--<variant>.html`.

- [ ] **Step 6: Route the callers.** Import `DEFAULT_VARIANT` from `./defaultVariant.js` where it is used.
  - `layout.layout.ts:31,42`: `gotoView('settings', { variant: 'populated', route: openRoute })`
  - `status.visual.ts:26`: `gotoView('dashboard', { variant: 'populated' })`
  - `stagePalette.visual.ts:44,53`: `gotoView('dashboard', { variant: 'pending' })`
  - `focus.visual.ts:175`, `a11y.visual.ts:174,328,372,390,440`: `gotoView(viewId, { variant: DEFAULT_VARIANT[viewId] })`
  - `contentCap.visual.ts:44,52,105`: `gotoView(view, { variant: DEFAULT_VARIANT[view] })`; `:59`: `gotoView('dashboard', { variant: 'pending' })`

- [ ] **Step 7: Update `docs/ui/responsive-audit/capture.ts`.** Import `fixtureFile` from `../../../tests/visual/variants.js`. Map the files: `dashboard-${s}.html` -> `fixtureFile('dashboard', s === 'running' ? 'populated' : s)`; `dashboard-running.html` -> `fixtureFile('dashboard', 'populated')`; `${v}.html` and `sidebar.html` -> `fixtureFile(v, 'populated')`; `settings-realistic.html` -> `fixtureFile('settings', 'populated')`.

- [ ] **Step 8: Add to `@ui:VISUAL-VARIANTS`** (after the `buildFixture.ts writes ...` sentence): "It writes no other page. A spec opens a page by its variant id; `tests/visual/defaultVariant.ts#DEFAULT_VARIANT` names the default page of each view."

- [ ] **Step 9: Verify.**
  - `npx vitest run tests/visual/fixtureThemes.test.ts tests/visual/fixtureScope.test.ts tests/visual/defaultVariant.test.ts tests/visual/variants.test.ts` -> PASS
  - `npm run -s typecheck` -> exit 0
  - `npm run -s typecheck:visual` -> exit 0 (a remaining `gotoView(view)` call or `scenario:` option fails here)
  - `grep -rn "scenario:" tests/visual/*.visual.ts tests/visual/*.layout.ts` -> no `gotoView` hit
  - The full visual sweep runs in the karst UAT `visual` gate (Docker); do not run it here.

- [ ] **Step 10: Commit.** `git add -A tests/visual docs/ui && git commit -m "refactor: write only variant fixture pages and open them by variant id"`
