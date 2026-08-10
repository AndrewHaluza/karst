# Pinned Sidebar Controls and Filters Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pin the sidebar's toolbar, search box, and facet chips above the ticket list so only the list scrolls — the filters and controls must stay reachable at the bottom of a long list.

**Architecture:** The sidebar webview (`src/ui/sidebar/webview.html`) currently lays out as one scrolling document: `body` scrolls, so the toolbar, search and facets scroll away with the rows. The fix converts it to an app shell — `html,body{height:100%}` with `body` an `overflow:hidden` flex column, the three header blocks pinned with `flex:0 0 auto`, and `.list` as the single `flex:1;min-height:0;overflow-y:auto` scroll container. Pure presentation: the host↔webview message protocol, actions, and persisted state are untouched (UI-R37).

**Tech Stack:** Plain HTML/CSS in the self-contained sidebar webview (CSP forbids external assets); text-level test pins in `src/ui/sidebar/webview.test.ts` (the repo has no DOM harness — UI-R36); one normative rule added to `docs/ui/UI-RULES.md`.

## Global Constraints

- **UI-R04:** Only `--k-*` tokens as style values. Exempt: `0`, `100%`. The new CSS adds no hex/`rgba()`/`px`/`rem` literal.
- **UI-R37:** No message, action, command, or persisted state changes — this is layout only.
- **UI-R36:** Webview assertions are text-level against the file; no DOM harness.
- **CSP:** No `<link>`, no `url()`, no external anything — edit only the existing inline `<style>`.
- **Verification:** `npx vitest run src/ui/sidebar/webview.test.ts` for the focused loop; `npm test` + `npm run typecheck` for the full gate.
- **Commit:** conventional commit, effect-stated subject (repo convention; `fix(sidebar): …`).
- Work happens on branch `karst/feat/fix-controls-and-filters-should-fix-controls-and-filters-sho`.

---

### Task 1: Pin the header block and make the ticket list the only scroll container

**Files:**
- Modify: `src/ui/sidebar/webview.html:15-22` (the `body` rule + new `html,body` rule)
- Modify: `src/ui/sidebar/webview.html:25-26` (`.toolbar` rule)
- Modify: `src/ui/sidebar/webview.html:30` (`.search` rule)
- Modify: `src/ui/sidebar/webview.html:36-37` (`.facets` rule)
- Modify: `src/ui/sidebar/webview.html:41` (`.list` rule)
- Modify: `src/ui/sidebar/webview.test.ts` (one new test in the existing `describe('sidebar webview.html')`)
- Modify: `docs/ui/UI-RULES.md` (append UI-R38 after UI-R37)
- Test: `src/ui/sidebar/webview.test.ts`

**Interfaces:**
- Consumes: nothing — no TS module changes, no message protocol changes.
- Produces: nothing consumed by later tasks — the plan has exactly one task. The host state protocol (`SidebarState`, `SidebarWebviewMessage`, `routeSidebarAction`) is untouched, so no test outside `webview.test.ts` changes.

- [ ] **Step 1: Write the failing test**

Append this test inside `describe('sidebar webview.html')` in `src/ui/sidebar/webview.test.ts` (place it after the 'declares no local :root block' test, before the 'contains no raw hex' test):

```ts
  it('pins toolbar/search/facets and scrolls only the ticket list (UI-R38)', () => {
    const [main] = styleBlocks();
    // App shell: html/body fill the view; body is a non-scrolling column.
    expect(main).toContain('html,body{height:100%}');
    const bodyRule = main.match(/body\{[^}]*\}/)?.[0] ?? '';
    expect(bodyRule).toContain('display:flex;flex-direction:column;');
    expect(bodyRule).toContain('overflow:hidden');
    // The three header blocks are pinned — they never flex out of view.
    expect(main).toMatch(/\.toolbar\{[^}]*flex:0 0 auto/);
    expect(main).toMatch(/\.search\{[^}]*flex:0 0 auto/);
    expect(main).toMatch(/\.facets\{[^}]*flex:0 0 auto/);
    // The list is the one flex child that may shrink below its content, and it
    // is the ONLY scroll container in the file.
    const listRule = main.match(/\.list\{[^}]*\}/)?.[0] ?? '';
    expect(listRule).toContain('flex:1;');
    expect(listRule).toContain('min-height:0;');
    expect(listRule).toContain('overflow-y:auto');
    expect(main.match(/overflow-y:auto/g) ?? []).toHaveLength(1);
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/ui/sidebar/webview.test.ts`
Expected: FAIL — `html,body{height:100%}` absent, `flex:0 0 auto` never appears inside the `.toolbar`/`.search`/`.facets` rules (only on `.glyph`/`.parentref`/`.stage`), and `overflow-y:auto` occurs 0 times.

- [ ] **Step 3: Implement the CSS**

In `src/ui/sidebar/webview.html`, replace lines 15-22 (the `*{box-sizing}` line through the closing `}` of `body`):

```html
  *{box-sizing:border-box}
  /* The view is an app shell, not a scrolling document: html/body fill the
     view, body is a non-scrolling column, and the ONLY thing that scrolls is
     the ticket list (UI-R38). The toolbar/search/facets stay pinned — on a
     long list they used to scroll away with the rows, leaving the filters
     and controls unreachable at the bottom. */
  html,body{height:100%}
  body{
    margin:0;padding:0;
    display:flex;flex-direction:column;overflow:hidden;
    background:var(--vscode-sideBar-background,var(--vscode-editor-background));
    color:var(--k-text);
    font-family:var(--k-font-ui);
    font-size:var(--k-text-base);
  }
```

Append `;flex:0 0 auto` inside the `.toolbar` rule (line 25-26), before the closing `}`:

```css
  .toolbar{display:flex;align-items:center;gap:var(--k-space-1);padding:var(--k-space-3) var(--k-space-4);
    border-bottom:var(--k-border-w) solid var(--k-border);flex:0 0 auto}
```

Append `;flex:0 0 auto` inside the `.search` rule (line 30):

```css
  .search{position:relative;margin:var(--k-space-4) var(--k-space-4) var(--k-space-3);flex:0 0 auto}
```

Append `;flex:0 0 auto` inside the `.facets` rule (line 36-37), before the closing `}`:

```css
  .facets{display:flex;gap:var(--k-space-3);flex-wrap:wrap;padding:0 var(--k-space-4) var(--k-space-4);
    border-bottom:var(--k-border-w) solid var(--k-border);flex:0 0 auto}
```

Replace the `.list` rule (line 41):

```css
  /* flex:1 + min-height:0: the list is the one flex child allowed to shrink
     below its content, which is what makes overflow-y scroll instead of
     growing the body past the viewport. */
  .list{flex:1;min-height:0;overflow-y:auto;padding:var(--k-space-1) 0}
```

Append UI-R38 to `docs/ui/UI-RULES.md`, after the UI-R37 rule:

```markdown
### UI-R38 — A scrolling surface keeps its controls pinned
A list that scrolls keeps the controls that act on it — header toolbar, search
box, filter chips — pinned above it. A control that scrolls away with the rows
it filters is unreachable at the bottom of a long list: the sidebar's ticket
list scrolled as one document until this rule, so the search box and facet
chips disappeared below the fold.

**Check:** the list is the only `overflow-y:auto` container in the webview's
main `<style>`; the shell (`body`) is `overflow:hidden` and fills the view
(`html,body{height:100%}`); pinned blocks are `flex:0 0 auto`; the list is
`flex:1` with `min-height:0`.
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/ui/sidebar/webview.test.ts`
Expected: PASS (all tests, including the new one).

Run: `npx vitest run src/ui/designSystem.test.ts src/ui/webviewCsp.test.ts`
Expected: PASS — the design-system discovery and CSP nonce suites are untouched by this change and must stay green.

- [ ] **Step 5: Full verification**

Run: `npm test`
Expected: all suites pass.

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/ui/sidebar/webview.html src/ui/sidebar/webview.test.ts docs/ui/UI-RULES.md
git commit -m "fix(sidebar): pin controls and filters above the scrolling ticket list (UI-R38)"
```

---

## Self-Review

**1. Spec coverage.** The ticket (manual, title only) resolves via the user's report: on a long list the toolbar, search and facet chips scroll away with the rows; they must stay fixed with only the list scrolling. Task 1 implements exactly that: header pinned (`flex:0 0 auto` ×3), shell non-scrolling (`html,body{height:100%}`, `body{overflow:hidden}` column), list as the single `overflow-y:auto` container (`flex:1;min-height:0`). No other requirement exists in the ticket. The `docs/ui/UI-RULES.md` addition gives the commit its citable rule id per the repository's "cite the rule id in the commit" convention.

**2. Placeholder scan.** Every step carries concrete code and exact line references; no TBD/TODO, no "add appropriate…". The before/after CSS is verbatim from the current file (verified: `.toolbar` spans lines 25-26, `.search` line 30, `.facets` lines 36-37, `.list` line 41, `body` lines 16-22; `overflow-y:auto` occurs 0 times today; `flex:0 0 auto` exists only on `.glyph`/`.parentref`/`.stage`, so the anchored regexes in the test cannot pass before the change).

**3. Type consistency.** No TS types or signatures are introduced or changed; the message protocol, `SidebarState`, and `routeSidebarAction` are untouched, so no cross-task name drift is possible. The test regexes anchor on rule heads (`.toolbar\{`, `.search\{`, `.facets\{`, `.list\{`, `body\{`) and therefore cannot false-positive on existing rules (`.toolbar .sp`, `.search-icon`, `.search-input`, `.facets .n`, `.name`, `.row`), and the `overflow-y:auto` count assertion would catch any future second scroll container.
