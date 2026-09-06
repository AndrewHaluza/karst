# Revamp Processes State and UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix three UI issues in the processes table: move nested status icons to the left, remove redundant count bubbles, and improve small-width layout.

**Architecture:** Changes are isolated to the dashboard webview's `#inside` block CSS/JS and the scope process model. The glyph positioning fix is a CSS-only change on `.ev-state`/`.gate-state` selectors. The count removal is a data-layer change in `model/inside/index.ts` plus the webview renderer. The responsive fix targets the `@container (max-width: 430px)` breakpoint.

**Tech Stack:** TypeScript (model layer), HTML/CSS/JS (webview), vitest (tests)

**Spec:** The ticket prompt describes three issues:
1. Nested process status icons are on the right but should be on the left (consistent with parent rows)
2. Parent rows show a redundant count bubble (e.g., "(1)") already stated in the description
3. Small-width UI looks collapsed in 2-column view

## Global Constraints

- All CSS changes stay scoped under `#inside` (the Inside prototype exemption)
- No raw color literals — use `--p-*` tokens pointing at `--k-*` tokens
- UI-R28b: workflow status markers are icon-only, no visible status word
- UI-R31: host supplies semantic facts, webview owns visual presentation
- UI-R37: domain behavior is preserved unless explicitly in scope
- UI-R35: cite rule ID in commits when a change satisfies a rule
- ESM imports require `.js` suffix; `moduleResolution: Bundler`
- Tests use vitest with in-memory SQLite via `openStore(':memory:')`

---

### Task 1: Move nested status glyphs to the left

**Files:**
- Modify: `src/ui/dashboard/webview.html:846-854` (CSS for `.ev-state`/`.gate-state`)
- Modify: `src/ui/dashboard/webview.test.ts` (add glyph position assertion)

**Interfaces:**
- Consumes: The existing `.ev-state`/`.gate-state` CSS selectors and `.glyph` primitive
- Produces: Evidence row glyphs render at the left edge of their status column

- [ ] **Step 1: Write the failing test**

```typescript
// In webview.test.ts, add a new test block near the existing inside ledger tests (~line 1597)
it('positions evidence row glyphs on the left, not the right', () => {
  // The ev-state span is display:inline-flex with justify-content, which
  // controls where the glyph sits inside the span. The default (flex-start)
  // puts the glyph on the left; flex-end pushes it right.
  // The fix adds a dedicated .ev-state rule with flex-start; verify it exists.
  expect(HTML).toMatch(/#inside \.ev-state\{[^}]*justify-content:flex-start/);
  // Gate rows keep flex-end — their glyph position is already correct.
  // The combined .gate-state rule should still have flex-end.
  expect(HTML).toMatch(/#inside \.gate-state\{[^}]*justify-content:flex-end/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/ui/dashboard/webview.test.ts -t "positions evidence row glyphs"`
Expected: FAIL — the current CSS has no standalone `.ev-state` rule with `justify-content:flex-start`; only the combined `.ev-state,.gate-state` rule with `flex-end` exists (line 846-848)

- [ ] **Step 3: Write minimal implementation**

In `src/ui/dashboard/webview.html`, change the combined `.ev-state,.gate-state` rule at line 854:

**Before:**
```css
#inside .ev-state,#inside .gate-state{gap:var(--p-s2)}
```

**After:**
```css
#inside .ev-state{justify-content:flex-start;gap:var(--p-s2)}
#inside .gate-state{gap:var(--p-s2)}
```

The `.ev-state` span is `display:inline-flex` with `justify-content:flex-end` (inherited from the combined rule at line 846-848). This pushes the glyph to the right end of the span. Changing to `justify-content:flex-start` moves it to the left, matching the parent process row's glyph position. Gate rows keep `flex-end` (their glyph position is already correct at the right of the row).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/ui/dashboard/webview.test.ts -t "positions evidence row glyphs"`
Expected: PASS

- [ ] **Step 5: Run full test suite**

Run: `npm run test:unit`
Expected: All tests PASS

- [ ] **Step 6: Commit**

```bash
git add src/ui/dashboard/webview.html src/ui/dashboard/webview.test.ts
git commit -m "fix: move evidence row status glyphs to the left (UI-R28b)

Nested process rows (evidence rows under Hot set, Worktrees, etc.) had
their status icon on the right side of the row due to
justify-content:flex-end on the .ev-state inline-flex span. This pushed
the glyph to the right end, inconsistent with parent process rows whose
glyph is always the first column.

Changed .ev-state to justify-content:flex-start so the glyph aligns left,
matching parent row layout. Gate rows keep their existing position."
```

---

### Task 2: Remove redundant count bubbles from process rows

**Files:**
- Modify: `src/model/inside/index.ts:164-169` (hot-set count)
- Modify: `src/model/inside/index.ts:238-244` (worktrees count)
- Modify: `src/ui/dashboard/renderFixtures.ts:200` (test fixture count)
- Modify: `src/ui/dashboard/webview.test.ts:4378` (test assertion)

**Interfaces:**
- Consumes: The `InsideProcessView.count` property (optional string)
- Produces: Process rows no longer render a count bubble when the detail text already states the count

- [ ] **Step 1: Write the failing test**

```typescript
// In webview.test.ts, add near the processRowHtml tests (~line 1877)
it('does not render a bare count bubble when detail already states the count', () => {
  const row = /function processRowHtml[\s\S]*?\n  \}/.exec(HTML)?.[0] ?? '';
  // The count bubble should only appear for aggregate (e.g. "4 passed · 1 failed"),
  // not for a bare count that duplicates the detail text.
  // Verify the renderer still supports aggregate but the scope processes
  // no longer set count.
  expect(row).toMatch(/p\.aggregate \? `<span class="count"/);
  // The count line itself still exists in the renderer (other processes may use it),
  // but scope's hot-set and worktrees no longer set it.
});
```

- [ ] **Step 2: Run test to verify it passes (existing behavior still works)**

Run: `npx vitest run src/ui/dashboard/webview.test.ts -t "does not render a bare count bubble"`
Expected: PASS (the renderer still supports count; we're removing it from the data layer)

- [ ] **Step 3: Remove count from hot-set process**

In `src/model/inside/index.ts`, remove the `count` property from the hot-set row (line 169):

**Before:**
```typescript
const hotSet: InsideProcessView = {
  id: 'hot-set',
  kind: 'hot-set',
  label: 'Hot set',
  status: stageProcessStatus(cell),
  count: String(count),
  detail:
    count === 1
      ? `1 service ${ran ? 'validated' : 'to validate'} against the manifest`
      : `${count} services ${ran ? 'validated' : 'to validate'} against the manifest`,
```

**After:**
```typescript
const hotSet: InsideProcessView = {
  id: 'hot-set',
  kind: 'hot-set',
  label: 'Hot set',
  status: stageProcessStatus(cell),
  detail:
    count === 1
      ? `1 service ${ran ? 'validated' : 'to validate'} against the manifest`
      : `${count} services ${ran ? 'validated' : 'to validate'} against the manifest`,
```

- [ ] **Step 4: Remove count from worktrees process**

In `src/model/inside/index.ts`, remove the `count` property from the worktrees row (lines 238-244):

**Before:**
```typescript
  ...(worktrees.length > 0
    ? {
        detail:
          worktrees.length === 1
            ? '1 worktree created'
            : `${worktrees.length} worktrees created`,
        count: String(worktrees.length),
      }
    : ran
      ? { detail: 'no worktrees created' }
      : { detail: 'not created yet' }),
```

**After:**
```typescript
  ...(worktrees.length > 0
    ? {
        detail:
          worktrees.length === 1
            ? '1 worktree created'
            : `${worktrees.length} worktrees created`,
      }
    : ran
      ? { detail: 'no worktrees created' }
      : { detail: 'not created yet' }),
```

- [ ] **Step 5: Update test fixture**

In `src/ui/dashboard/renderFixtures.ts`, remove the `count` property from the hot-set fixture (line 200):

**Before:**
```typescript
      {
        id: 'hot-set',
        kind: 'hot-set',
        label: 'Hot set',
        status: 'pending',
        count: String(n),
        detail: `${n} services to validate against the manifest`,
```

**After:**
```typescript
      {
        id: 'hot-set',
        kind: 'hot-set',
        label: 'Hot set',
        status: 'pending',
        detail: `${n} services to validate against the manifest`,
```

- [ ] **Step 6: Update webview test assertion**

In `src/ui/dashboard/webview.test.ts`, line 4393 currently asserts:
```typescript
    expect(html).toContain('<span class="count">6</span>');
```

This test uses a fixture that sets `count: '6'` directly. Since the renderer still supports `count`, this test should still pass. Verify by running the test. If it fails, the test fixture at that line needs its `count` removed too.

Run: `npx vitest run src/ui/dashboard/webview.test.ts -t "count"`
Expected: Check if this specific test still passes

- [ ] **Step 7: Run full test suite**

Run: `npm run test:unit`
Expected: All tests PASS

- [ ] **Step 8: Run typecheck**

Run: `npm run typecheck`
Expected: No type errors

- [ ] **Step 9: Commit**

```bash
git add src/model/inside/index.ts src/ui/dashboard/renderFixtures.ts src/ui/dashboard/webview.test.ts
git commit -m "fix: remove redundant count bubbles from scope process rows

The Hot set and Worktrees process rows showed a bare count bubble (e.g.
\"(1)\") in the tail that duplicated information already stated in the
detail text (e.g. \"1 service validated against the manifest\"). Removed
the count property from both scope process reducers so the detail text
is the single source of truth.

The renderer still supports count/aggregate for other processes that
need it (graph node counts, etc.)."
```

---

### Task 3: Improve small-width responsive layout

**Files:**
- Modify: `src/ui/dashboard/webview.html:1183-1235` (container query at 430px)

**Interfaces:**
- Consumes: The existing `@container (max-width: 430px)` breakpoint
- Produces: Better layout at small widths, especially in 2-column view

- [ ] **Step 1: Write the failing test**

```typescript
// In webview.test.ts, add near the responsive tests (~line 1741)
it('keeps evidence-row and gate-row readable at 430px container width', () => {
  const blockFor = (w) => {
    const start = HTML.indexOf(`@container (max-width: ${w})`);
    if (start === -1) return '';
    const end = HTML.indexOf('}', start);
    return HTML.slice(start, end + 1);
  };
  const wide = blockFor('430px');
  // Evidence rows must keep a readable label + detail layout
  expect(wide).toMatch(/#inside \.evidence-row\{grid-template-columns:/);
  // Gate rows must keep repo + name + detail visible
  expect(wide).toMatch(/#inside \.gate-row\{grid-template-columns:/);
});
```

- [ ] **Step 2: Run test to verify it passes (existing behavior)**

Run: `npx vitest run src/ui/dashboard/webview.test.ts -t "keeps evidence-row and gate-row readable"`
Expected: PASS

- [ ] **Step 3: Improve the 430px breakpoint**

In `src/ui/dashboard/webview.html`, update the `@container (max-width: 430px)` block. The key changes:

1. Give evidence rows a minimum detail width so content doesn't collapse
2. Ensure gate rows keep the name column readable
3. Add wrapping for long detail text instead of aggressive ellipsis

**Before (line 1196-1197):**
```css
    #inside .evidence-row{grid-template-columns:70px minmax(0,1fr)}
    #inside .ev-state{grid-column:2}
```

**After:**
```css
    #inside .evidence-row{grid-template-columns:minmax(60px,80px) minmax(0,1fr) auto}
    #inside .ev-state{grid-column:3}
```

This keeps three columns at 430px (label, detail, status) instead of collapsing to two, preventing the status from wrapping onto a new line and keeping the layout readable.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/ui/dashboard/webview.test.ts -t "keeps evidence-row and gate-row readable"`
Expected: PASS

- [ ] **Step 5: Run full test suite**

Run: `npm run test:unit`
Expected: All tests PASS

- [ ] **Step 6: Run typecheck**

Run: `npm run typecheck`
Expected: No type errors

- [ ] **Step 7: Commit**

```bash
git add src/ui/dashboard/webview.html
git commit -m "fix: improve process table layout at small container widths

At 430px container width, evidence rows collapsed to two columns which
pushed the status glyph onto the detail text's line. Restored three
columns (label, detail, status) with a constrained label width so
content stays readable in 2-column panel views.

Cites UI-R36 (visual verification required for reflow/layout stability)."
```

---

### Task 4: Verify and finalize

**Files:**
- None (verification only)

- [ ] **Step 1: Run full test suite**

Run: `npm run test:unit`
Expected: All tests PASS

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: No type errors

- [ ] **Step 3: Visual verification checklist**

Verify in VS Code with the dashboard open:
- [ ] Nested process rows (under Hot set, Worktrees, gates) have status glyphs on the LEFT
- [ ] Parent process rows (Hot set, Worktrees) do NOT show a count bubble in the tail
- [ ] The detail text still shows the count (e.g., "1 service validated against the manifest")
- [ ] At narrow panel width (2-column view), evidence rows remain readable without collapse
- [ ] Gate rows remain readable at narrow width
- [ ] Graph node list glyphs are unaffected (they have their own grid)

- [ ] **Step 4: Commit any fixups**

If any visual issues are found, fix and commit before proceeding.

---

## Self-Review

**1. Spec coverage:**
- Issue 1 (glyph position): Covered by Task 1 — CSS change on `.ev-state` moves glyph left
- Issue 2 (redundant count): Covered by Task 2 — remove `count` from scope process reducers
- Issue 3 (small width): Covered by Task 3 — adjust 430px breakpoint grid columns

**2. Placeholder scan:** No TBD/TODO found. All steps contain actual code and commands.

**3. Type consistency:**
- `count` is optional on `InsideProcessView` (types.ts:703) — removing it is safe
- `aggregate` is separate and untouched — graph process rows unaffected
- CSS selectors `.ev-state`/`.gate-state` are used consistently across evidence, gates, findings, and done-line rows
