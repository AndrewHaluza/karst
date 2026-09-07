# Inside-block status-first rows Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In the dashboard's Inside block, every evidence-layer row leads with its status glyph instead of trailing it, so a gate row reads *status · label · command · description · time+duration*.

**Architecture:** All three affected row shapes are rendered by string-template functions inside the single webview file `src/ui/dashboard/webview.html` (the webview is one self-contained HTML document; there is no framework). Today `evStateHtml()` bundles time + duration + glyph into one trailing cell. The change splits that cell in two — a leading `evGlyphHtml()` status cell and a trailing `evTimingHtml()` time/duration cell — and prepends a fixed 18px glyph track to the three row grids that carry a status glyph (`.evidence-row`, `.gate-row`, `.recovery-round`). Only ordering and grid geometry change; no host-side data shape, no status vocabulary, no accessible name changes.

**Tech Stack:** TypeScript (ESM), vitest, plain HTML/CSS/JS webview string templates, CSS container queries.

**Spec:** the ticket prompt REVAMP-PROCESSES-STATE-AND-UI-fu1 (reproduced under "Requirements" below) plus `docs/ui/UI-RULES.md`, `docs/ui/UI-INVARIANTS.md`, `docs/ui/DESIGN-SYSTEM.md`.

## Requirements (verbatim from the ticket)

> Green checkmarks still on right side of gates and in general for those layer of elements in the inside block
>
> rework to
>
> for gates
>
> from: *label* *command* *description* *time with duration* *status (green\blue\needs-you\errored)*
>
> to: *status (green\blue\needs-you\errored)* *label* *command* *description* *time with duration*
>
> make status first for all same elements in the Inside block.

## Global Constraints

- Every UI change is judged pass/fail against `docs/ui/UI-RULES.md` (v3.0). Cite the rule id in the commit when a change exists to satisfy one (UI-R35).
- UI-R28b: the status marker stays **icon-only** — never add a visible status word inside the status primitive. The glyph keeps its `aria-label` accessible name (`statusWord(...)`).
- UI-R04/R05: at 430px / 360px / 300px container widths the block must never scroll horizontally, and a narrow rule may **re-area** a cell but never `display:none` the status glyph, the name, or the action.
- UI-R31: the webview concatenates nothing the host should have joined — do not build new prose strings.
- Edit the SOURCE `src/ui/dashboard/webview.html`. Never edit the `dist/` copy (`scripts/copy-assets.mjs` mirrors it).
- Strict TDD (RED→GREEN). Conventional commits, one per task. No mutation of existing objects.
- Do NOT change `evidenceFindingsHtml` (`.finding`) or the done receipt's `.done-line`: neither renders a status glyph — the finding leads with its severity word already, and `.done-state` is a time/duration text cell. This is deliberate scope, stated in the ticket's own terms ("those layer of elements" = the rows that carry the green check).

## File Structure

Only two files change.

| File | Responsibility | Change |
|---|---|---|
| `src/ui/dashboard/webview.html` | The whole dashboard webview: CSS + render functions | Split `evStateHtml` into `evGlyphHtml` + `evTimingHtml`; reorder three row renderers; add a leading 18px track to three row grids and to their container-query overrides; add `.ev-glyph` CSS |
| `src/ui/dashboard/webview.test.ts` | STATIC assertions over the raw HTML string plus render assertions over the rendered output | Update the assertions that pin the old trailing-glyph geometry; add new ones pinning the leading glyph |

No new files. `webview.html` is large by design (one document); do not split it.

## Current code, for reference

Renderers (around `src/ui/dashboard/webview.html:2556`, `:2629`, `:2641`, `:2789`):

```js
  function evStateHtml(r, cls) {
    if (!r.status) return `<span class="${cls}"></span>`;
    const time = r.time
      ? `<span class="ev-time" title="started ${esc(r.time)}">${esc(r.time)}</span>`
      : '';
    const dur = r.duration
      ? `<span class="ev-dur"${r.durationExact ? ` title="${esc(r.durationExact)}"` : ''}>${esc(r.duration)}</span>`
      : '';
    return `<span class="${cls} ${esc(r.status)}">${time}${dur}`
      + `<span class="glyph ${esc(r.status)}" aria-label="${esc(statusWord(r.status))}"></span></span>`;
  }
```

Row grids (around `:840`, `:908`, `:1027`) and their `@container (max-width: 430px)` overrides (around `:1193`).

---

### Task 1: Split the status cell into a glyph cell and a timing cell

**Files:**
- Modify: `src/ui/dashboard/webview.html` (the `evStateHtml` function, ~line 2556)
- Test: `src/ui/dashboard/webview.test.ts`

**Interfaces:**
- Consumes: existing `statusWord(status)` and `esc(s)` helpers already defined in the file.
- Produces, for Tasks 2–4:
  - `evGlyphHtml(r)` → string. Always returns exactly one grid item: `<span class="ev-glyph"></span>` when `r.status` is falsy, otherwise `<span class="ev-glyph"><span class="glyph <status>" aria-label="<statusWord>"></span></span>`.
  - `evTimingHtml(r, cls)` → string. Always returns exactly one grid item: `<span class="<cls>"></span>` when `r.status` is falsy, otherwise `<span class="<cls> <status>">` wrapping the optional `.ev-time` and `.ev-dur` spans and **no glyph**.
  - `evStateHtml` is deleted; nothing may reference it afterwards.

- [ ] **Step 1: Write the failing test**

Add to `src/ui/dashboard/webview.test.ts`, inside the top-level `describe` that holds the other `HTML`-string assertions (the one where `HTML` is already in scope — the same block as the test named `positions evidence row glyphs on the left, not the right`):

```ts
  it('renders the status glyph and the timing as two separate cells', () => {
    // The glyph cell is the row's FIRST grid item and carries no timing; the
    // timing cell is the row's LAST and carries no glyph. One function each,
    // so no renderer can accidentally re-bundle them (UI-R28b).
    expect(HTML).toContain('function evGlyphHtml(r) {');
    expect(HTML).toContain('function evTimingHtml(r, cls) {');
    expect(HTML).not.toContain('function evStateHtml(');
    const glyphFn = HTML.slice(HTML.indexOf('function evGlyphHtml(r) {'),
      HTML.indexOf('function evTimingHtml(r, cls) {'));
    expect(glyphFn).toContain('class="ev-glyph"');
    expect(glyphFn).not.toContain('ev-dur');
    expect(glyphFn).not.toContain('ev-time');
    const timingFn = HTML.slice(HTML.indexOf('function evTimingHtml(r, cls) {'),
      HTML.indexOf('function evTimingHtml(r, cls) {') + 700);
    expect(timingFn).toContain('ev-time');
    expect(timingFn).toContain('ev-dur');
    expect(timingFn).not.toContain('class="glyph');
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/ui/dashboard/webview.test.ts -t 'two separate cells'`
Expected: FAIL — `expect(HTML).toContain('function evGlyphHtml(r) {')` fails because the function does not exist.

- [ ] **Step 3: Write minimal implementation**

In `src/ui/dashboard/webview.html`, replace the whole `evStateHtml` function (keep the explanatory comment block above it, amended as shown) with:

```js
  // An evidence row's status is the GLYPH, not a word: the word repeated what
  // the row's own detail already said ("selected … passed") on every row of
  // every expanded body. The word survives as the glyph's accessible name, so
  // nothing that cannot see colour loses the status (UI-R28b).
  //
  // The glyph LEADS the row and the timing TRAILS it, in two separate cells:
  // a verdict read after the prose is a verdict read last, and the check that
  // sat at the row's right edge was the thing the eye had to hunt for. Two
  // functions rather than one bundled cell, so no renderer can re-pair them.
  // Both always emit exactly ONE grid item, empty when the row has no status,
  // so a statusless row keeps the grid's column alignment.
  function evGlyphHtml(r) {
    if (!r.status) return `<span class="ev-glyph"></span>`;
    return `<span class="ev-glyph"><span class="glyph ${esc(r.status)}"`
      + ` aria-label="${esc(statusWord(r.status))}"></span></span>`;
  }
  function evTimingHtml(r, cls) {
    if (!r.status) return `<span class="${cls}"></span>`;
    const time = r.time
      ? `<span class="ev-time" title="started ${esc(r.time)}">${esc(r.time)}</span>`
      : '';
    const dur = r.duration
      ? `<span class="ev-dur"${r.durationExact ? ` title="${esc(r.durationExact)}"` : ''}>${esc(r.duration)}</span>`
      : '';
    return `<span class="${cls} ${esc(r.status)}">${time}${dur}</span>`;
  }
```

Leave the two call sites (`evidenceRowsHtml`, `evidenceGatesHtml`) still calling `evStateHtml` for this step only if the file would otherwise not parse — it will parse fine, they are runtime references, but the tests in Tasks 2 and 3 fix them. To keep the suite green at every commit, ALSO apply the mechanical call-site rename now:

- In `evidenceRowsHtml`, change `evStateHtml(r, 'ev-state')` to `evTimingHtml(r, 'ev-state')`.
- In `evidenceGatesHtml`, change `evStateHtml(r, 'gate-state')` to `evTimingHtml(r, 'gate-state')`.

(The glyph is re-inserted at the front of each row in Tasks 2 and 3.)

- [ ] **Step 4: Update the tests that pinned the bundled cell**

Two existing assertions describe the old bundled cell and must be restated, not deleted:

In `src/ui/dashboard/webview.test.ts:3004`, replace:

```ts
    expect(html).toMatch(/<span class="ev-state [a-z]+">(?:<span class="ev-dur">[^<]*<\/span>)?<span class="glyph [a-z]+" aria-label="(?:pending|passed)"><\/span><\/span>/);
```

with:

```ts
    // The glyph leads the row; the timing cell trails it and holds no glyph.
    expect(html).toMatch(/<span class="ev-glyph"><span class="glyph [a-z]+" aria-label="(?:pending|passed)"><\/span><\/span>/);
    expect(html).toMatch(/<span class="ev-state [a-z]+">(?:<span class="ev-dur">[^<]*<\/span>)?<\/span>/);
```

In `src/ui/dashboard/webview.test.ts:3597` the comment references `evStateHtml` by name; change that word to `evGlyphHtml` so the comment stays true.

- [ ] **Step 5: Run the whole webview suite**

Run: `npx vitest run src/ui/dashboard/webview.test.ts`
Expected: PASS. If the test at line ~3713 ("The process tail AND the row's ev-state cell both title their duration") fails, it is asserting on `.ev-dur` inside `.ev-state` — that still holds, so a failure there means the timing cell lost its duration; re-check Step 3.

- [ ] **Step 6: Commit**

```bash
git add src/ui/dashboard/webview.html src/ui/dashboard/webview.test.ts
git commit -m "refactor: split the inside row status cell into glyph and timing (UI-R28b)"
```

---

### Task 2: Gate rows lead with the status glyph

**Files:**
- Modify: `src/ui/dashboard/webview.html` — `evidenceGatesHtml` (~line 2641), the `#inside .gate-row` / `.gates.no-repo .gate-row` rules (~line 908), the `@container (max-width: 430px)` gate rules (~line 1193)
- Test: `src/ui/dashboard/webview.test.ts`

**Interfaces:**
- Consumes: `evGlyphHtml(r)` and `evTimingHtml(r, cls)` from Task 1 (signatures above).
- Produces: a `.gate-row` whose children are, in order — `.ev-glyph`, `.gate-repo` (omitted when no row names a repo), `.gate-name`, `.gate-detail`, `.gate-state`.

- [ ] **Step 1: Write the failing test**

Add to `src/ui/dashboard/webview.test.ts`, in the same `HTML`-string describe block:

```ts
  it('leads every gate row with its status glyph (UI-R28b)', () => {
    const fn = HTML.slice(HTML.indexOf('function evidenceGatesHtml(ev) {'),
      HTML.indexOf('function evidenceGatesHtml(ev) {') + 900);
    // The glyph cell is emitted before the repo, the name and the detail.
    expect(fn.indexOf('evGlyphHtml(r)')).toBeGreaterThan(-1);
    expect(fn.indexOf('evGlyphHtml(r)')).toBeLessThan(fn.indexOf('gate-repo'));
    expect(fn.indexOf('evGlyphHtml(r)')).toBeLessThan(fn.indexOf('gate-name'));
    expect(fn.indexOf('gate-detail')).toBeLessThan(fn.indexOf("evTimingHtml(r, 'gate-state')"));
    // The grid gains a leading fixed track for that glyph, in both the
    // repo-bearing and the repo-less shapes.
    expect(HTML).toMatch(/#inside \.gate-row\{display:grid;grid-template-columns:18px minmax\(74px,90px\) minmax\(110px,150px\) minmax\(0,1fr\) auto;/);
    expect(HTML).toMatch(/#inside \.gates\.no-repo \.gate-row\{grid-template-columns:18px minmax\(110px,150px\) minmax\(0,1fr\) auto\}/);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/ui/dashboard/webview.test.ts -t 'leads every gate row'`
Expected: FAIL — `evGlyphHtml(r)` is not found in `evidenceGatesHtml` (`indexOf` returns `-1`, so the `toBeGreaterThan(-1)` assertion fails).

- [ ] **Step 3: Write minimal implementation**

In `src/ui/dashboard/webview.html`, replace the body of `evidenceGatesHtml` with:

```js
  function evidenceGatesHtml(ev) {
    const hasRepo = ev.rows.some((r) => !!r.repo);
    return `<div class="gates${hasRepo ? '' : ' no-repo'}">${ev.rows.map((r) => `<div class="gate-row${r.status === 'run' ? ' active' : ''}">`
      + evGlyphHtml(r)
      + (hasRepo ? `<span class="gate-repo">${esc(r.repo || '')}</span>` : '')
      + `<span class="gate-name">${esc(r.label)}</span>`
      + `<span class="gate-detail">${esc(r.detail || '')}</span>`
      + evTimingHtml(r, 'gate-state')
      + `</div>`).join('')}</div>`;
  }
```

Then the CSS. Replace:

```css
  #inside .gate-row{display:grid;grid-template-columns:minmax(74px,90px) minmax(110px,150px) minmax(0,1fr) auto;
```

with:

```css
  #inside .gate-row{display:grid;grid-template-columns:18px minmax(74px,90px) minmax(110px,150px) minmax(0,1fr) auto;
```

and replace:

```css
  #inside .gates.no-repo .gate-row{grid-template-columns:minmax(110px,150px) minmax(0,1fr) auto}
```

with:

```css
  #inside .gates.no-repo .gate-row{grid-template-columns:18px minmax(110px,150px) minmax(0,1fr) auto}
```

Add the glyph cell's own rule immediately after the `#inside .ev-tail{...}` rule (~line 858):

```css
  /* The status cell now LEADS the row (869e-status-first): a fixed, never
     shrinking track so every row's glyph lands on the same vertical line
     whatever the row's prose does. */
  #inside .ev-glyph{display:inline-flex;align-items:center;justify-content:center;
    min-height:18px;width:18px;flex:none}
```

Inside `@container (max-width: 430px)` replace:

```css
    #inside .gate-row{grid-template-columns:58px 70px minmax(0,1fr)}
    #inside .gate-repo{display:none}
    #inside .gates.no-repo .gate-row{grid-template-columns:58px 70px minmax(0,1fr)}
    #inside .gate-state{grid-column:3}
```

with:

```css
    #inside .gate-row{grid-template-columns:18px 70px minmax(0,1fr)}
    #inside .gate-repo{display:none}
    #inside .gates.no-repo .gate-row{grid-template-columns:18px 70px minmax(0,1fr)}
    #inside .gate-state{grid-column:3}
```

(With the repo hidden, the remaining cells are glyph, name, detail, timing; the timing keeps its explicit `grid-column:3` so it shares the detail's track's row rather than wrapping to a fourth.)

- [ ] **Step 4: Update the narrow-width assertion that pinned the old track list**

In `src/ui/dashboard/webview.test.ts:1754`, replace:

```ts
    expect(wide).toMatch(/#inside \.gate-row\{grid-template-columns:58px 70px minmax\(0,1fr\)\}/);
```

with:

```ts
    // The glyph track leads even at 430px — the status is never the cell that
    // gets dropped (UI-R04/R05); the repo column is.
    expect(wide).toMatch(/#inside \.gate-row\{grid-template-columns:18px 70px minmax\(0,1fr\)\}/);
```

- [ ] **Step 5: Run the whole webview suite**

Run: `npx vitest run src/ui/dashboard/webview.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/ui/dashboard/webview.html src/ui/dashboard/webview.test.ts
git commit -m "fix: lead gate rows with the status glyph (UI-R28b)"
```

---

### Task 3: Generic evidence rows lead with the status glyph

**Files:**
- Modify: `src/ui/dashboard/webview.html` — `evidenceRowsHtml` (~line 2629), the `#inside .evidence-row` rule (~line 840), the `#inside .ev-state{justify-content:flex-start...}` rule (~line 854), the `@container (max-width: 430px)` evidence rules (~line 1197)
- Test: `src/ui/dashboard/webview.test.ts`

**Interfaces:**
- Consumes: `evGlyphHtml(r)`, `evTimingHtml(r, cls)` from Task 1; `evActionHtml(r)` and `graphNodeListHtml(nodes)`, both already in the file, unchanged.
- Produces: an `.evidence-row` whose children are, in order — `.ev-glyph`, `.ev-key`, `.ev-detail`, then either `.ev-tail` (when the row carries an action) or `.ev-state` (the timing cell).

- [ ] **Step 1: Write the failing test**

Add to `src/ui/dashboard/webview.test.ts`, in the same `HTML`-string describe block:

```ts
  it('leads every generic evidence row with its status glyph (UI-R28b)', () => {
    const fn = HTML.slice(HTML.indexOf('function evidenceRowsHtml(ev) {'),
      HTML.indexOf('function evidenceRowsHtml(ev) {') + 700);
    expect(fn.indexOf('evGlyphHtml(r)')).toBeGreaterThan(-1);
    expect(fn.indexOf('evGlyphHtml(r)')).toBeLessThan(fn.indexOf('ev-key'));
    expect(fn.indexOf('ev-detail')).toBeLessThan(fn.indexOf("evTimingHtml(r, 'ev-state')"));
    expect(HTML).toMatch(/#inside \.evidence-row\{display:grid;grid-template-columns:18px minmax\(74px,100px\) minmax\(0,1fr\) auto;/);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/ui/dashboard/webview.test.ts -t 'leads every generic evidence row'`
Expected: FAIL — `evGlyphHtml(r)` is absent from `evidenceRowsHtml`.

- [ ] **Step 3: Write minimal implementation**

In `src/ui/dashboard/webview.html`, replace the body of `evidenceRowsHtml` with:

```js
  function evidenceRowsHtml(ev) {
    const nodes = ev.nodes && ev.nodes.length ? graphNodeListHtml(ev.nodes) : '';
    return nodes + ev.rows.map((r) => `<div class="evidence-row">`
      + evGlyphHtml(r)
      + `<span class="ev-key">${esc(r.label)}</span>`
      + `<span class="ev-detail">${esc(r.detail || '')}`
      + (r.prState ? `<span class="pr-status ${esc(r.prState)}">${esc(r.prState)}</span>` : '')
      + `</span>`
      + (r.action ? evActionHtml(r) : evTimingHtml(r, 'ev-state'))
      + `</div>`).join('');
  }
```

Replace the grid rule:

```css
  #inside .evidence-row{display:grid;grid-template-columns:minmax(74px,100px) minmax(0,1fr) auto;
```

with:

```css
  #inside .evidence-row{display:grid;grid-template-columns:18px minmax(74px,100px) minmax(0,1fr) auto;
```

The trailing timing cell now sits at the row's right edge, so it aligns right like the gate row's. Replace:

```css
  #inside .ev-state{justify-content:flex-start;gap:var(--p-s2)}
```

with:

```css
  /* The timing cell is now the row's LAST item — the glyph it used to hold
     moved to the leading `.ev-glyph` cell — so it aligns to the row's right
     edge like every other trailing fact. */
  #inside .ev-state{justify-content:flex-end;gap:var(--p-s2)}
```

Inside `@container (max-width: 430px)` replace:

```css
    #inside .evidence-row{grid-template-columns:minmax(60px,80px) minmax(0,1fr) auto}
    #inside .ev-state{grid-column:3}
```

with:

```css
    #inside .evidence-row{grid-template-columns:18px minmax(60px,80px) minmax(0,1fr)}
    #inside .ev-state{grid-column:3}
```

- [ ] **Step 4: Update the two assertions that pinned the old geometry**

In `src/ui/dashboard/webview.test.ts:1710` the test named `positions evidence row glyphs on the left, not the right` asserted the old bundled cell's internal alignment. Replace that whole `it(...)` block with:

```ts
  it('positions the row status glyph in its own leading cell, not the tail', () => {
    // The glyph is no longer aligned INSIDE a trailing cell — it is its own
    // first grid item, and the trailing cell holds only time and duration.
    expect(HTML).toMatch(/#inside \.ev-glyph\{[^}]*justify-content:center/);
    expect(HTML).toMatch(/#inside \.ev-state\{[^}]*justify-content:flex-end/);
    expect(HTML).toMatch(/#inside \.gate-state\{[^}]*justify-content:flex-end/);
  });
```

Note the `.gate-state` assertion matches the shared `#inside .ev-state,#inside .gate-state{...}` declaration block only if that block is what carries `justify-content:flex-end` — it does (`justify-content:flex-end` is declared there today). If the regex fails, anchor it to the standalone `#inside .gate-state{gap:...}` rule instead by adding `justify-content:flex-end` to that standalone rule.

In `src/ui/dashboard/webview.test.ts:1757`, replace:

```ts
    expect(wide).toMatch(/#inside \.evidence-row\{grid-template-columns:minmax\(60px,80px\) minmax\(0,1fr\) auto\}/);
```

with:

```ts
    // Glyph, label, detail at 430px — the status track leads and the timing
    // re-areas onto the detail's track (never display:none — UI-R04/R05).
    expect(wide).toMatch(/#inside \.evidence-row\{grid-template-columns:18px minmax\(60px,80px\) minmax\(0,1fr\)\}/);
```

- [ ] **Step 5: Run the whole webview suite**

Run: `npx vitest run src/ui/dashboard/webview.test.ts`
Expected: PASS. The breakpoint test `never introduces whole-component horizontal scrolling at the breakpoints (B7)` asserts no `display:none` on `.glyph` or `.ev-state` at any width — neither edit adds one.

- [ ] **Step 6: Commit**

```bash
git add src/ui/dashboard/webview.html src/ui/dashboard/webview.test.ts
git commit -m "fix: lead generic evidence rows with the status glyph (UI-R28b)"
```

---

### Task 4: Recovery rounds lead with the status glyph

**Files:**
- Modify: `src/ui/dashboard/webview.html` — `evidenceRecoveryHtml` (~line 2789), the `#inside .recovery-round` and `#inside .recovery-result` rules (~line 1027), the `@container (max-width: 430px)` recovery rules (~line 1222)
- Test: `src/ui/dashboard/webview.test.ts`

**Interfaces:**
- Consumes: `evGlyphHtml(r)` from Task 1. A recovery row's status may be absent, and `evGlyphHtml` renders an empty cell for that case — which is a behaviour change from the old code, which fell back to the `note` status. Preserve the old fallback by passing a normalised row (see the implementation below) rather than by changing `evGlyphHtml`.
- Produces: a `.recovery-round` whose children are, in order — `.ev-glyph`, `.recovery-num`, `.recovery-cause`, `.recovery-timing`. The `.recovery-result` span is removed.

- [ ] **Step 1: Write the failing test**

Add to `src/ui/dashboard/webview.test.ts`, in the same `HTML`-string describe block:

```ts
  it('leads every recovery round with its status glyph (UI-R28b)', () => {
    const fn = HTML.slice(HTML.indexOf('function evidenceRecoveryHtml(ev) {'),
      HTML.indexOf('function evidenceRecoveryHtml(ev) {') + 800);
    expect(fn.indexOf('evGlyphHtml(')).toBeGreaterThan(-1);
    expect(fn.indexOf('evGlyphHtml(')).toBeLessThan(fn.indexOf('recovery-num'));
    // The trailing status cell is gone; the timing is the row's last item.
    expect(fn).not.toContain('recovery-result');
    expect(HTML).toMatch(/#inside \.recovery-round\{display:grid;grid-template-columns:18px 56px minmax\(0,1fr\) auto;/);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/ui/dashboard/webview.test.ts -t 'leads every recovery round'`
Expected: FAIL — `evGlyphHtml(` is absent from `evidenceRecoveryHtml`.

- [ ] **Step 3: Write minimal implementation**

In `src/ui/dashboard/webview.html`, replace the body of `evidenceRecoveryHtml` with:

```js
  // A round with no recorded status still shows a glyph: `note` is the neutral
  // outcome the history has always drawn for an unresolved round, so the row
  // is normalised (never mutated) before the shared glyph cell renders it.
  function evidenceRecoveryHtml(ev) {
    return `<div class="recovery-history">${ev.rows.map((r) => `<div class="recovery-round">`
      + evGlyphHtml({ ...r, status: r.status || 'note' })
      + `<span class="recovery-num">${esc(r.label)}</span>`
      + `<span class="recovery-cause">${esc(r.detail || '')}</span>`
      + `<span class="recovery-timing">`
      + (r.time ? `<span title="started ${esc(r.time)}">${esc(r.time)}</span>` : '')
      + (r.duration ? `<span class="ev-dur"${r.durationExact ? ` title="${esc(r.durationExact)}"` : ''}>${esc(r.duration)}</span>` : '')
      + `</span>`
      + `</div>`).join('')}</div>`;
  }
```

Replace the grid rule:

```css
  #inside .recovery-round{display:grid;grid-template-columns:56px minmax(0,1fr) auto auto;gap:var(--p-s2);
```

with:

```css
  #inside .recovery-round{display:grid;grid-template-columns:18px 56px minmax(0,1fr) auto;gap:var(--p-s2);
```

Delete these four now-dead rules (nothing renders `.recovery-result` any more):

```css
  #inside .recovery-result{display:inline-flex;align-items:center;justify-content:flex-end;gap:var(--p-s2);
    color:var(--p-muted2);font-family:var(--p-mono);font-size:var(--p-xs);white-space:nowrap}
  #inside .recovery-result.run{color:var(--p-running)}
  #inside .recovery-result.fail{color:var(--p-failed)}
  #inside .recovery-result.pass{color:var(--p-passed)}
```

Inside `@container (max-width: 430px)` replace:

```css
    #inside .recovery-round{grid-template-columns:48px minmax(0,1fr)}
    #inside .recovery-timing{display:none}
    #inside .recovery-result{grid-column:2}
```

with:

```css
    #inside .recovery-round{grid-template-columns:18px 48px minmax(0,1fr)}
    #inside .recovery-timing{display:none}
```

- [ ] **Step 4: Update the recovery render assertions**

`src/ui/dashboard/webview.test.ts:3598` asserts the old word-free result cell:

```ts
    expect(html).not.toContain('<span class="recovery-result run">running</span>');
```

Replace it with an assertion on the new shape:

```ts
    // No status WORD anywhere in the round (UI-R28b) — the glyph carries it.
    expect(html).not.toContain('recovery-result');
    expect(html).toContain('<span class="ev-glyph"><span class="glyph run"');
```

`src/ui/dashboard/webview.test.ts:3646` carries the comment "The glyph is still in the separate .recovery-result cell." — read the assertion beneath it and restate both: the comment becomes "The glyph is the round's leading `.ev-glyph` cell." and any `recovery-result` string in that assertion becomes `ev-glyph`.

- [ ] **Step 5: Run the whole webview suite**

Run: `npx vitest run src/ui/dashboard/webview.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/ui/dashboard/webview.html src/ui/dashboard/webview.test.ts
git commit -m "fix: lead recovery rounds with the status glyph (UI-R28b)"
```

---

### Task 5: Full verification and dist parity

**Files:**
- Verify only: `src/ui/dashboard/webview.html`, `src/ui/dashboard/webview.test.ts`, `src/ui/conformance.test.ts`

**Interfaces:**
- Consumes: everything Tasks 1–4 produced.
- Produces: nothing new — this task is the gate.

- [ ] **Step 1: Prove no caller of the deleted function survives**

Run: `grep -rn "evStateHtml\|recovery-result" src/`
Expected: no output. Any hit is a live reference to something Tasks 1 and 4 removed — fix it before continuing.

- [ ] **Step 2: Run the UI conformance suite**

Run: `npx vitest run src/ui/conformance.test.ts src/ui/designSystem.test.ts`
Expected: PASS. These enforce the design-system token path; the edits introduce no raw colour and no new token.

- [ ] **Step 3: Run the whole unit suite**

Run: `npm run test:unit`
Expected: PASS, no failures. Report the actual tail of the output; do not claim a pass you did not read.

- [ ] **Step 4: Typecheck and build**

Run: `npm run typecheck && npm run build`
Expected: both exit 0. The build re-copies `webview.html` into `dist/` — confirm the copy carries the change:

Run: `grep -c "ev-glyph" dist/ui/dashboard/webview.html`
Expected: a count greater than 0.

- [ ] **Step 5: Commit anything the verification changed**

If Steps 1–4 required no edits, there is nothing to commit and this step is a no-op. Otherwise:

```bash
git add -A src
git commit -m "fix: settle inside status-first fallout across the webview suite"
```

---

## Self-Review

**1. Spec coverage.** The ticket asks for gates to read *status · label · command · description · time+duration* — Task 2 delivers exactly that order (`.ev-glyph`, `.gate-repo` = the repo/command scope, `.gate-name` = the label, `.gate-detail` = the description, `.gate-state` = time+duration). "Make status first for all same elements in the Inside block" — Tasks 3 and 4 cover the other two row shapes that render a status glyph (`.evidence-row`, `.recovery-round`). `.graph-node` already leads with its glyph and needs no change. `.finding` and `.done-line` render no status glyph and are explicitly out of scope under Global Constraints.

**2. Placeholder scan.** Every code step carries the literal replacement text. The one judgement call left to the executor is the `.gate-state` regex fallback in Task 3 Step 4, which names the exact fix if the anchor misses.

**3. Type consistency.** `evGlyphHtml(r)` takes one argument everywhere (Tasks 2, 3, 4); `evTimingHtml(r, cls)` takes two and is called with `'ev-state'` (Task 3) and `'gate-state'` (Task 2) only. `evActionHtml(r)` and `graphNodeListHtml(nodes)` are pre-existing and unchanged. The class `ev-glyph` is spelled identically in the renderer, the CSS rule, and all four tests.
