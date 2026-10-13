# Agents Page Roles Table Layout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rework the Settings > Agents > Roles table (`#agents/roles`) so one shared column template aligns every column, the picker splits into aligned Core/Model/Effort sub-columns, labels never break mid-word, controls keep fixed slots, Karst-supplied defaults carry the Karst mark, and the table re-flows into labelled cards below 1000px.

**Architecture:** One shared six-track grid (switch | Role | Agent profile | picker | Source | Actions) drives the header and every row. The picker is ONE cell; inside it the compact grid splits into Core/Model/Effort on a fixed `1fr / 1.6fr / 0.8fr` template, and the header repeats that template so the sub-columns line up (UI-R41). The compact Effort field renders a disabled `—` select (dashed, dim) instead of a wrapped div. Below 1000px the same DOM re-flows into a card by CSS only: a top line (switch | Role | Source | Actions) and a four-column line (Agent profile | Core | Model | Effort), narrowing to one column at <=699px. A `KarstMark` primitive (ICONS-05 exception) marks Karst-supplied values; the source chip and the built-in profile already use it.

**Tech Stack:** React (Settings app, `src/ui/settings/app/**`), vanilla picker runtime (`src/model/agentPicker.webview.js`), plain CSS with `--k-*` tokens, vitest (+ jsdom), Playwright visual/layout (docker).

**Spec:** Ticket `AGENTS-PAGE-ROLES-TABLE-LAYOUT` step-by-step spec (attachment `spilled-description.txt`), binding per `ui:UI-R39`. Design reference https://claude.ai/artifact/8d7fhSuGCqrhTZJhGUdiqN (mockup colours/fonts/icons are stand-ins). Rules: `docs/ui/UI-RULES.md` `ui:UI-R35/R39/R41/R43/R44`; `docs/ui/ICONS.md` `ui:ICONS-05`; `docs/ui/README.md` `ui:README-ORDER`/`ui:README-VOCAB`; `docs/ui/DESIGN-SYSTEM.md` `ui:LAYOUT-PRIMITIVES`.

## Global Constraints

- Tiers: wide >=1000px, mid 700-999px, narrow <=699px; `agents.webview.css` is pinned to these in `src/ui/layout/layoutBreakpoints.test.ts` — only `@media (max-width: 999px)` and `(max-width: 699px)`.
- Tokens only (`--k-*`, `--vscode-*`); no hex colours. Icons via `TablerIcon` catalog names (`file-text` exists) — never hand-drawn SVG, except the Karst mark (`ui:ICONS-05`).
- Labels never break mid-word: the 472ee4af `overflow-wrap:anywhere` overrides stay deleted. Never add `overflow-wrap:anywhere` for ids.
- Ellipsis + full text: a truncated id keeps its full text in the trigger's title and accessible name AND in the model menu (`.ap-model-sub` prints the raw id), which is keyboard-reachable — satisfies `ui:UI-R44`.
- The page never scrolls sideways (`ui:UI-R43`); no horizontal scroll container for the table.
- Out of scope: Model cell content (D111), toolbar and tokens (D110), focus and contrast (D109). Keep today's model label.
- `compact` is used ONLY by `RoleRows.tsx` (re-check with `grep`); the picker changes are safe for the shared picker.
- OpenCode core mark stays the rectangle (by design); do not replace it.
- Strict TDD, conventional commits, small files. Never edit visual baselines or `tests/visual/layout-known-failures.json` by hand; `npm run -s test:visual:docker:update` only after the user approves screenshots.
- **Base already contains PR #595** (`a00dd2ba`), which implemented the same feature with a different technique (8-track `display:contents` picker, a placeholder `div`, `agents-pin-slot`). This ticket REPLACES that technique with the spec's six-track/picker-grid one. Update the tests that pin the old technique.
- **Rule conflicts -> STOP AND ASK.** Ask before editing rule docs, baselines or the ledger, or weakening a gate.

## File Structure

| File | Responsibility |
|---|---|
| `src/model/agentPicker.webview.js` | Compact Effort renders a disabled `—` select (`ap-effort--na`); compact fields lose `role="cell"` (the row's picker cell is the cell) |
| `src/model/agentPicker.webview.css` | Compact grid `1fr/1.6fr/0.8fr`; `.ap-effort--na` dashed/dim |
| `src/model/agentPicker.test.ts` | Pins the placeholder select, the compact template, no `role="cell"` |
| `src/ui/settings/agents.webview.css` | Six-track template, picker sub-template, `agents-slot`, card tiers |
| `src/ui/settings/agentsCss.test.ts` | Pins the six-track template, the sub-template, cards, no-sideways-scroll |
| `src/ui/settings/app/sections/RoleRows.tsx` | Picker cell is one `role="cell"`; `agents-slot` |
| `src/ui/settings/app/sections/RolesTab.tsx` | Header: one picker columnheader with a three-span grid |
| `src/ui/settings/app/sections/AgentsSection.test.tsx` | Header/cell contract for the new layout |
| `tests/visual/**` | Run docker visual; baselines re-recorded only with user approval |

Before editing any `docs/` block, read it with the awk extractor from `CLAUDE.md` and keep the `END_DOC_BLOCK` format.

---

### Task 1: Compact Effort placeholder is a disabled select

**Files:**
- Modify: `src/model/agentPicker.webview.js` (root template ~292-297, `renderEffort` ~345-364)
- Modify: `src/model/agentPicker.webview.css` (`.ap-compact` line 5, placeholder rules 57-61)
- Test: `src/model/agentPicker.test.ts` (`describe('compact effort placeholder')`, ~429-460)

**Interfaces:**
- Consumes: `apEffortMode(efforts, saved, compact) -> 'select' | 'placeholder' | 'hidden'` (unchanged).
- Produces: the compact Effort field is a `<select data-ap-effort class="ap-effort ap-effort--na" disabled>` with one `<option value="" selected>—</option>` and `aria-label="Effort: not available for this model"`, only when `compact && mode === 'placeholder'`. Every other path sets `sel.disabled` from the picker's own disabled state and does NOT carry `ap-effort--na`. `.ap-effort-placeholder` is removed entirely.

- [ ] **Step 1: Update the failing tests**

In `src/model/agentPicker.test.ts`, replace the body of the final `it('ships the placeholder markup and CSS', …)` with:

```ts
  it('ships the disabled select placeholder and its CSS', () => {
    expect(js).toContain('ap-effort--na');
    expect(js).toContain('\\u2014');
    expect(js).toContain(': not available for this model');
    expect(js).not.toContain('data-ap-effort-placeholder');
    expect(agentPickerCss()).toContain('.ap-effort--na');
    expect(agentPickerCss()).toMatch(/\.ap-effort--na\{[^}]*color:var\(--k-text-dim\)[^}]*dashed/);
  });

  it('pins the compact Core | Model | Effort template', () => {
    expect(agentPickerCss()).toContain(
      '.ap-compact{grid-template-columns:minmax(0,1fr) minmax(0,1.6fr) minmax(96px,0.8fr)',
    );
  });

  it('compact fields are not table cells (the row owns the picker cell now)', () => {
    expect(js).not.toContain("role=\\\"cell\\\"");
  });
```

Also delete the existing `it('compact fields are table cells …')` block in `describe('truncated trigger text stays reachable (UI-R44)')` (~475-478) since the picker fields are no longer cells.

- [ ] **Step 2: Run to verify FAIL**

Run: `npx vitest run src/model/agentPicker.test.ts`
Expected: FAIL — `.ap-effort--na` missing, `data-ap-effort-placeholder` still present, the template and cell pins fail.

- [ ] **Step 3: Implement**

In `agentPicker.webview.css`, change line 5 to (keeps the ticket's template verbatim):

```css
.ap-compact{grid-template-columns:minmax(0,1fr) minmax(0,1.6fr) minmax(96px,0.8fr);align-items:center;gap:var(--k-space-3)}
```

Replace the `.ap-effort-placeholder` block (lines 57-61) with:

```css
.ap-effort--na{color:var(--k-text-dim);border-style:dashed;opacity:1;cursor:default}
```

In `agentPicker.webview.js`, delete the two placeholder-div template lines (the `ap-effort-placeholder` `+` lines inside the effort field). Replace `renderEffort` with:

```js
  function renderEffort() {
    var field = $('[data-ap-effort-field]');
    var sel = $('[data-ap-effort]');
    if (!showEffort) { field.hidden = true; return; }
    var efforts = apEfforts(catalog, state.core, state.model);
    var mode = apEffortMode(efforts, state.effort, compact);
    if (mode === 'placeholder') {
      field.hidden = false;
      sel.disabled = true;
      sel.classList.add('ap-effort--na');
      sel.innerHTML = '<option value="" selected>\u2014</option>';
      sel.setAttribute('aria-label', apEsc(labelEffort) + ': not available for this model');
      state.effort = '';
      return;
    }
    sel.classList.remove('ap-effort--na');
    sel.disabled = disabled;
    if (mode === 'hidden') {
      field.hidden = true;
      state.effort = '';
      return;
    }
    field.hidden = false;
    var effortInherit = labels().effort || (compact ? 'No effort' : '');
    var built = apEffortOptions(catalog, state.core, state.model, state.effort, effortInherit);
    sel.innerHTML = built.html || '<option value="" selected>' + apEsc(effortInherit || 'No effort (agent picks)') + '</option>';
  }
```

In `setDisabled`, keep the placeholder disabled:

```js
    var effort = $('[data-ap-effort]');
    if (effort) effort.disabled = disabled || effort.classList.contains('ap-effort--na');
```

In the root template, drop `role="cell"`: change `var cellRole = compact ? ' role="cell"' : '';` to `var cellRole = '';` and leave the three `+ cellRole` concatenations in place (they now emit nothing) — or delete the variable and its three uses. Delete the variable and the three `' + cellRole` fragments.

- [ ] **Step 4: Run to verify PASS**

Run: `npx vitest run src/model/agentPicker.test.ts` then `npm run -s typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/model/agentPicker.webview.js src/model/agentPicker.webview.css src/model/agentPicker.test.ts
git commit -m "fix: compact picker renders a disabled '-' Effort select, drops the placeholder div and nested cells (UI-R39, UI-R44)"
```

---

### Task 2: Six-track template, picker cell, header sub-columns

**Files:**
- Modify: `src/ui/settings/agents.webview.css` (template block 64-110, truncation block 243-256, tiers 258-302)
- Modify: `src/ui/settings/app/sections/RoleRows.tsx` (picker cell ~146)
- Modify: `src/ui/settings/app/sections/RolesTab.tsx` (header 149-169)
- Test: `src/ui/settings/agentsCss.test.ts`, `src/ui/settings/app/sections/AgentsSection.test.tsx`

**Interfaces:**
- Consumes: Task 1's picker (one cell, three compact fields).
- Produces: row DOM contract — six direct children, all `role="cell"` in order `.agents-cell-switch`, `.agents-cell-role`, `.agents-cell-profile`, `.agents-cell-picker`, `.agents-cell-source`, `.agents-cell-actions`. Header has six `columnheader`s; the picker one is `class="agents-cell-picker-head"` and contains `.agents-picker-head-grid` with three spans (Core, Model, Effort). CSS variables `--agents-cols` (six tracks) and `--agents-picker-cols` (three sub-tracks) live on `.agents-table`.

- [ ] **Step 1: Write the failing tests**

Replace `src/ui/settings/agentsCss.test.ts` with:

```ts
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync('src/ui/settings/agents.webview.css', 'utf8');
const pickerCss = readFileSync('src/model/agentPicker.webview.css', 'utf8');

const COLS = 'var(--k-hit-min) minmax(140px, 1fr) minmax(150px, 1fr) minmax(360px, 3fr) auto calc(2 * var(--k-hit-min) + var(--k-space-1))';
const PICKER_COLS = 'minmax(0, 1fr) minmax(0, 1.6fr) minmax(96px, 0.8fr)';

describe('agents.webview.css — roles table', () => {
  it('uses one six-track template for header and rows', () => {
    const cols = /--agents-cols:\s*([^;]+);/.exec(css)![1]!.replace(/\s+/g, ' ').trim();
    expect(cols).toBe(COLS);
    expect(css.match(/grid-template-columns:\s*var\(--agents-cols\)/g)!.length).toBeGreaterThanOrEqual(1);
  });
  it('splits the picker into Core | Model | Effort on a shared sub-template', () => {
    expect(css).toMatch(/--agents-picker-cols:\s*minmax\(0, 1fr\) minmax\(0, 1\.6fr\) minmax\(96px, 0\.8fr\)/);
    expect(css).toMatch(/\.agents-cell-picker-head[^{]*\{[^}]*grid-template-columns:\s*var\(--agents-picker-cols\)/);
    expect(pickerCss).toContain(`.ap-compact{grid-template-columns:${PICKER_COLS}`);
  });
  it('no longer turns the picker cell into the row grid (no display: contents)', () => {
    expect(css).not.toContain('display: contents');
    expect(css).not.toContain('subgrid');
  });
  it('never breaks words mid-word and keeps the 472ee4af overrides deleted', () => {
    expect(css).not.toContain('overflow-wrap: anywhere');
    expect(css).not.toContain('overflow-wrap:anywhere');
    expect(css).not.toMatch(/\.ap-trigger-label[^{]*\{[^}]*white-space:\s*normal/);
    expect(css).not.toMatch(/\.k-chip\s*\{[^}]*white-space:\s*normal/);
  });
  it('truncates model labels with an ellipsis on one line', () => {
    expect(css).toMatch(/\.agents-cell-picker \.ap-trigger-label[^{]*\{[^}]*text-overflow:\s*ellipsis/);
    expect(css).toMatch(/\.agents-cell-picker \.ap-trigger-label[^{]*\{[^}]*white-space:\s*nowrap/);
  });
  it('hides field labels on wide rows and shows them on cards', () => {
    expect(css).toMatch(/\.agents-field-label\s*\{[^}]*display:\s*none/);
    expect(css).toMatch(/@media \(max-width: 999px\)[\s\S]*?#section-agents \.agents-field-label\s*\{[^}]*display:\s*block/);
  });
  it('keeps the action slot the size of an icon button', () => {
    expect(css).toMatch(/\.agents-slot\s*\{[^}]*width:\s*var\(--k-hit-min\)/);
    expect(css).not.toContain('agents-pin-slot');
  });
  it('lays the mid tier out as a labelled card and stacks at the narrow tier', () => {
    expect(css).toMatch(/@media \(max-width: 999px\)[\s\S]*grid-template-areas:\s*'sw role src act' 'f f f f'/);
    expect(css).toMatch(/@media \(max-width: 699px\)[\s\S]*\.agents-cell-picker[\s\S]*grid-column:\s*1 \/ -1/);
  });
  it('never scrolls the page sideways', () => {
    expect(css).not.toMatch(/\.agents-table\s*\{[^}]*overflow-x:\s*(auto|scroll)/);
  });
});
```

In `src/ui/settings/app/sections/AgentsSection.test.tsx`, inside `describe('Agents page — roles table layout markup')`, replace the header test and the picker-cells test:

```tsx
  it('header has an empty "Enabled" first column and one picker column with Core/Model/Effort spans', () => {
    mount();
    const heads = screen.getAllByRole('columnheader');
    expect(heads.map((h) => h.textContent)).toEqual(['Enabled', 'Role', 'Agent profile', 'CoreModelEffort', 'Source', 'Actions']);
    expect(heads[0]!.querySelector('.sr-only')!.textContent).toBe('Enabled');
    const spans = Array.from(heads[3]!.querySelectorAll('.agents-picker-head-grid > span'));
    expect(spans.map((s) => s.textContent)).toEqual(['Core', 'Model', 'Effort']);
  });

  it('every normal row has the same six cells in the same order, all role=cell', () => {
    mount();
    for (const r of document.querySelectorAll('.agents-row[data-role]')) {
      expect(cells(r).map((c) => c.split(' ').find((n) => n.startsWith('agents-cell-')))).toEqual([
        'agents-cell-switch', 'agents-cell-role', 'agents-cell-profile',
        'agents-cell-picker', 'agents-cell-source', 'agents-cell-actions',
      ]);
      expect(Array.from(r.children).map((c) => c.getAttribute('role'))).toEqual([
        'cell', 'cell', 'cell', 'cell', 'cell', 'cell',
      ]);
    }
  });
```

Also rename `.agents-pin-slot` to `.agents-slot` in the non-pinnable test (~284).

- [ ] **Step 2: Run to verify FAIL**

Run: `npx vitest run src/ui/settings/agentsCss.test.ts src/ui/settings/app/sections/AgentsSection.test.tsx`
Expected: FAIL on the new template, header and slot assertions.

- [ ] **Step 3: Implement**

(a) In `agents.webview.css`, replace the roles-table block (current lines 64-110) with:

```css
/* Roles table: ONE track template shared by header and rows (UI-R41). Columns:
   switch | Role | Agent profile | picker (Core · Model · Effort) | Source | Actions.
   The picker is ONE column; its compact grid splits it into Core/Model/Effort and
   the header repeats that sub-template so the sub-columns line up. */
#section-agents .agents-table {
  --agents-cols: var(--k-hit-min) minmax(140px, 1fr) minmax(150px, 1fr)
                 minmax(360px, 3fr) auto calc(2 * var(--k-hit-min) + var(--k-space-1));
  --agents-picker-cols: minmax(0, 1fr) minmax(0, 1.6fr) minmax(96px, 0.8fr);
  display: flex;
  flex-direction: column;
  border: var(--k-border-w) solid var(--vscode-panel-border, var(--k-border));
  border-radius: var(--k-radius-md);
}

#section-agents .agents-row {
  display: grid;
  grid-template-columns: var(--agents-cols);
  column-gap: var(--k-space-2);
  align-items: center;
  min-height: calc(var(--k-control-h-lg) + 2 * var(--k-space-2));
  padding: 0 var(--k-space-3);
  border-left: 3px solid transparent;
  border-top: var(--k-border-w) solid var(--vscode-panel-border, var(--k-border));
}

#section-agents .agents-compare-row,
#section-agents .agents-table .agents-head:has(+ .agents-compare-row) {
  grid-template-columns: var(--k-hit-min) minmax(120px, 1.1fr) minmax(0, 1.4fr) minmax(0, 1.4fr) calc(2 * var(--k-hit-min) + var(--k-space-1));
}

/* Cells fill their row height so an empty cell (no switch) and the sr-only
   "Enabled" heading still have a box. */
#section-agents .agents-row > [role="cell"],
#section-agents .agents-row > [role="columnheader"] { align-self: stretch; min-width: 0; }
#section-agents .agents-row > [role="columnheader"] { display: flex; align-items: center; }

#section-agents .agents-cell-picker { display: flex; align-items: center; }
#section-agents .agents-cell-picker > .agent-picker-island { flex: 1 1 auto; min-width: 0; }
#section-agents .agents-cell-picker .ap-compact { grid-template-columns: var(--agents-picker-cols); }
#section-agents .agents-cell-picker .ap-shell { width: 100%; }
#section-agents .agents-cell-picker .ap-trigger,
#section-agents .agents-cell-picker .ap-effort { width: 100%; min-width: 0; max-width: 100%; box-sizing: border-box; }
#section-agents .agents-cell-picker-head > .agents-picker-head-grid {
  display: grid;
  grid-template-columns: var(--agents-picker-cols);
  gap: var(--k-space-3);
  width: 100%;
}
#section-agents .agents-cell-source { justify-content: flex-start; }
#section-agents .agents-cell-actions { display: flex; justify-content: flex-end; gap: var(--k-space-1); }
#section-agents .agents-slot { display: inline-block; width: var(--k-hit-min); height: var(--k-hit-min); flex: none; visibility: hidden; }
#section-agents .agents-field-label { display: none; font-size: var(--k-text-xs); color: var(--k-text-dim); }
#section-agents .agents-cell-switch { justify-content: center; }
#section-agents .agents-role-name { font-weight: 500; overflow-wrap: break-word; }
```

(b) Keep `#section-agents .agents-cell { min-width: 0; display: flex; align-items: center; gap: var(--k-space-1) var(--k-space-2); }` and the head rule (current lines 112-117) as they are.

(c) In the "Targets and truncation" block (current 243-256), keep the `min-height`/`min-width` pins and the identifier rules, but they now scope to the picker cell (unchanged selectors already say `.agents-cell-picker .ap-trigger-label` etc.). Delete the old `.agents-cell-picker > .agent-picker-island { flex: 1 1 100% }` if present (it is not) and keep `.agents-muted { min-width: 0 }`.

(d) Replace the two tier blocks (current 258-302) with:

```css
/* Tiers: wide >= 1000, mid 700-999 (labelled cards), narrow <= 699 (src/ui/layout/layoutBreakpoints.ts). */
@media (max-width: 999px) {
  #section-agents .agents-head { display: none; }
  /* Card: top line = switch | Role | Source | Actions, then Agent profile | Core | Model | Effort. */
  #section-agents .agents-row {
    grid-template-columns: repeat(4, minmax(0, 1fr));
    grid-template-areas: 'sw role src act' 'f f f f';
    row-gap: var(--k-space-2);
    padding: var(--k-space-3);
  }
  #section-agents .agents-cell-switch  { grid-area: sw; justify-content: flex-start; }
  #section-agents .agents-cell-role    { grid-area: role; }
  #section-agents .agents-cell-source  { grid-area: src; justify-content: flex-end; }
  #section-agents .agents-cell-actions { grid-area: act; }
  #section-agents .agents-cell-profile { grid-area: f; grid-column: 1 / span 1; }
  #section-agents .agents-cell-picker  { grid-area: f; grid-column: 2 / -1; }
  #section-agents .agents-field-label { display: block; }
  #section-agents .agents-cell-picker .ap-compact .ap-label {
    position: static; width: auto; height: auto; overflow: visible; clip: auto; clip-path: none; white-space: normal;
  }
  #section-agents .agents-cell-source .agents-field-label { display: none; }
  /* compare rows: switch | name, then A and B side by side, actions last */
  #section-agents .agents-compare-row .agents-cell-switch { grid-area: sw; }
  #section-agents .agents-compare-row .agents-cell-role { grid-area: role; }
  #section-agents .agents-compare-row > .agents-cell:not(.agents-cell-switch):not(.agents-cell-role):not(.agents-cell-actions) {
    grid-column: span 2; grid-row: 2; grid-area: auto; flex-direction: column; align-items: flex-start;
  }
  #section-agents .agents-compare-row .agents-cell-actions { grid-area: act; grid-column: 1 / -1; grid-row: 3; justify-content: flex-start; }
}
@media (max-width: 699px) {
  #section-agents .agents-row {
    grid-template-columns: var(--k-hit-min) minmax(0, 1fr) auto auto;
    grid-template-areas: 'sw role src act' 'p p p p' 'k k k k';
  }
  #section-agents .agents-cell-profile { grid-column: 1 / -1; grid-row: 2; grid-area: auto; }
  #section-agents .agents-cell-picker  { grid-column: 1 / -1; grid-row: 3; grid-area: auto; }
  #section-agents .agents-cell-picker .ap-compact { grid-template-columns: minmax(0, 1fr); }
  #section-agents .agents-compare-row > .agents-cell:not(.agents-cell-switch):not(.agents-cell-role):not(.agents-cell-actions) {
    grid-column: 1 / -1; grid-row: auto; grid-area: auto;
  }
  #section-agents .agents-compare-row .agents-cell-actions { grid-column: 1 / -1; grid-row: auto; grid-area: auto; }
  #section-agents .agents-profiles { grid-template-columns: minmax(0, 1fr); }
  #section-agents .agents-profiles.has-selection .agents-list { display: none; }
  #section-agents .agents-profiles:not(.has-selection) .agents-detail { display: none; }
  #section-agents .agents-back { display: inline-flex; }
}
```

Make `agents.webview.css` contain NO `agents-pin-slot` and NO `display: contents`.

(e) In `RoleRows.tsx`, add `role="cell"` to the picker cell and rename the pin slot:

```tsx
      <div className="agents-cell agents-cell-picker" role="cell">
```

```tsx
          <span className="agents-slot" aria-hidden="true" />
```

(f) In `RolesTab.tsx`, replace the four header cells `Agent profile` / `Core` / `Model` / `Effort` with:

```tsx
              <div role="columnheader">Agent profile</div>
              <div role="columnheader" className="agents-cell-picker-head">
                <span className="agents-picker-head-grid">
                  <span>Core</span>
                  <span>Model</span>
                  <span>Effort</span>
                </span>
              </div>
```

- [ ] **Step 4: Run**

Run: `npx vitest run src/ui/settings/agentsCss.test.ts src/ui/settings/app/sections/AgentsSection.test.tsx src/model/agentPicker.test.ts` then `npm run -s typecheck && npm run -s lint:react`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ui/settings/agents.webview.css src/ui/settings/agentsCss.test.ts src/ui/settings/app/sections/RoleRows.tsx src/ui/settings/app/sections/RolesTab.tsx src/ui/settings/app/sections/AgentsSection.test.tsx
git commit -m "fix: Roles table uses the six-track template with a picker sub-grid, fixed slots and labelled cards (UI-R35, UI-R39, UI-R41, UI-R43)"
```

---

### Task 3: Verify, mutate, and close out

**Files:** none new.

- [ ] **Step 1: Related tests** — `npx vitest related src/model/agentPicker.webview.js src/ui/settings/app/sections/RoleRows.tsx src/ui/settings/app/sections/RolesTab.tsx src/ui/settings/agents.webview.css` then fix failures by rerunning only the failing file.

- [ ] **Step 2: Type + lint + render tests** — `npm run -s typecheck && npm run -s lint:react`, then `npx vitest run src/ui/settings/app/sections/renderedAgents.render.integration.test.tsx`. Fix any expectation that pins the old header text (`Core · Model · Effort`) or the old `agents-pin-slot`.

- [ ] **Step 3: Mutation gate** — `src/model/**` and `src/ui/**` are outside `src/extension/**`; confirm with `grep -n "mutate" stryker.config.json` and skip. Do not add excludes.

- [ ] **Step 4: Full unit suite once** — `npm run -s test:unit 2>&1 | tail -15`.

- [ ] **Step 5: Docker layout + visual** — `npm run -s test:layout:docker 2>&1 | tail -40` and `npm run -s test:visual:docker 2>&1 | tail -40`. Read the agents screenshots at 1200 / 850 / 600px in light, dark and high-contrast. If screenshots changed, STOP and ask the user to approve re-recording the baselines; run `npm run -s test:visual:docker:update` only after approval. If layout check (d) flags clipped text or any UI rule conflicts, STOP AND ASK.

- [ ] **Step 6: Post one bulletin note** (optional) and fire the stage marker (`stage` MCP tool `{ stage: "impl" }`).

---

## Self-Review

**Spec coverage** (ticket step -> task): step 1 six-column template -> T2(a); step 2 switch first + empty columnheader -> already present, T2(c); step 3 picker sub-columns + header spans -> T1(template) + T2(d,f); step 4 no mid-word wrap -> T2(c); step 5 core icon inline -> already present (`.agent-identity` inline-flex; no change); step 6 compact `—` placeholder -> T1; step 7 fixed action slots -> T2(e); step 8 file icon -> already present; step 9 Karst mark + 'default' -> already present (from a00dd2ba); step 10 mid-tier labelled cards -> T2(d); step 11 narrow one column -> T2(d); step 12 compare rows -> T2(d). Done-when: T3.

**Placeholder scan:** none. One deliberate engineering decision: the a00dd2ba card used 12 tracks + `display:contents`; this plan uses the spec's four equal tracks and a real picker sub-grid, because a shared six-track row cannot size row one (hit-min switch) and row two (equal columns) independently.

**Type consistency:** CSS vars `--agents-cols` / `--agents-picker-cols` are declared once on `.agents-table` and read in the same file and in `agentPicker.webview.css`'s fallback literal. Classes `agents-cell-switch|role|profile|picker|picker-head|source|actions`, `agents-picker-head-grid`, `agents-slot`, `agents-field-label`, `ap-effort--na` are the same in markup, tests and CSS. `apEffortMode` keeps its `'select'|'placeholder'|'hidden'` contract.
