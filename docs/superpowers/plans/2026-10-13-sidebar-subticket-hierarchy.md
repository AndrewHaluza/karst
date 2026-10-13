# Sidebar Sub-ticket Hierarchy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Tickets sidebar's sub-ticket hierarchy readable — a bigger fixed indent, hairline tree guides with an elbow on the last child, a distinct sub-tree collapse glyph, and the `⊂ <parentKey>` ref dropped when the parent is visible in the same rendered list.

**Architecture:** The host (`nestSubtasks` in `src/ui/sidebar/items.ts`) already orders rows parent-first and stamps `subtaskDepth`/`subtaskChildCount`. We extend it to stamp the two facts a tree renderer needs — `subtaskIsLast` (this row is the last child of its parent) and `subtaskGuides: boolean[]` (per ancestor slot: does the vertical guide continue below this row) — and let the webview paint them CSS-only. The webview gains an absolutely-positioned `.guides` span (one `.guide` per indent slot, `aria-hidden`) and swaps the shared `chevron-right` on `.subchev` for an icon pair that reads as a sub-tree.

**Tech Stack:** TypeScript (ESM, vitest), plain HTML/CSS/vanilla-JS webview, the injected Tabler icon catalog (`src/model/tablerIcons.ts`).

**Spec:** Ticket SIDEBAR-MAKE-SUB-TICKET prompt + context brief, and the binding UI rules `@ui:UI-R09`, `@ui:UI-R09b`, `@ui:ICONS-02`, `@ui:ICONS-04`, `@ui:ICONS-07`, `@ui:README-ORDER`.

## Global Constraints

- Host-agnostic: the webview never re-derives the tree; all tree facts come from `nestSubtasks` (UI-R31).
- Values come from tokens, never hard-coded px/hex outside the injected design system (UI-R04; enforced by `src/ui/sidebar/webview.test.ts`).
- Indent step is **12px** = `--k-space-6`. The deepest indent is `MAX_SUBTASK_INDENT` (4); no `nest5`.
- The sub-tree collapse control keeps its right-edge position and is a separate `<button>` with `aria-expanded` (UI-R09/UI-R09b).
- New Tabler glyphs are added verbatim from upstream (ICONS-07) and use the shared treatment (ICONS-04); no local redraw.
- `vscode` stays out of these modules; all logic runs under vitest with fakes.
- Test naming rule: this work touches no child/network/jsdom-document path, so files stay `*.test.*`.
- Commit after each task with a conventional message; cite the rule id when a change exists to satisfy one (UI-R35).

---

### Task 1: Stamp tree facts in `nestSubtasks`

**Files:**
- Modify: `src/ui/sidebar/items.ts` (interface `TicketNode`, `buildTicketNodes`, `nestSubtasks`)
- Test: `src/ui/sidebar/items.test.ts`

**Interfaces:**
- Produces: `TicketNode.subtaskIsLast: boolean`, `TicketNode.subtaskGuides: boolean[]`, both stamped by `nestSubtasks<T extends TicketNode>(rows): T[]`.
  - For a row at depth `d > 0` with path node `p[j]` at depth `j` (1..d, `p[d]` = the row): `subtaskIsLast = isLastChild(p[d])`; `subtaskGuides[k] = !isLastChild(p[k+1])` for `k = 0..d-1`, so `subtaskGuides.length === d` and `subtaskGuides[d-1] === !subtaskIsLast`.
  - A root (`d === 0`) gets `subtaskIsLast: false` and `subtaskGuides: []`.

- [ ] **Step 1: Write the failing tests** — in `items.test.ts`, extend the `nestSubtasks` `node()` helper with `subtaskIsLast: false, subtaskGuides: []`, then add:

```ts
it('stamps which child is last and which ancestor guides continue', () => {
  // A ⊃ A1 ⊃ A1a, A2 ;  B  (root order A, B)
  const rows = [
    node({ ticketId: 1, subtaskParentId: null }),
    node({ ticketId: 2, subtaskParentId: 1 }),
    node({ ticketId: 3, subtaskParentId: 2 }),
    node({ ticketId: 4, subtaskParentId: 1 }),
    node({ ticketId: 5, subtaskParentId: null }),
  ];
  const byId = new Map(nestSubtasks(rows).map((r) => [r.ticketId, r]));
  expect(byId.get(2)!.subtaskIsLast).toBe(false);      // A1 has sibling A2
  expect(byId.get(2)!.subtaskGuides).toEqual([true]);  // A (root) has sibling B
  expect(byId.get(3)!.subtaskIsLast).toBe(true);       // A1a is A1's only child
  expect(byId.get(3)!.subtaskGuides).toEqual([true, false]); // slot0 continues, slot1 elbow
  expect(byId.get(4)!.subtaskIsLast).toBe(true);       // A2 is A's last child
  expect(byId.get(4)!.subtaskGuides).toEqual([false]);
  expect(byId.get(1)!.subtaskIsLast).toBe(false);
  expect(byId.get(1)!.subtaskGuides).toEqual([]);
});
```

- [ ] **Step 2: Run test to verify it fails** — `npx vitest run src/ui/sidebar/items.test.ts` → FAIL (`subtaskIsLast`/`subtaskGuides` undefined / TS error).

- [ ] **Step 3: Implement** — add the two fields to `TicketNode` (defaulted in `buildTicketNodes` to `false` / `[]`) and rewrite `nestSubtasks`'s `emit` to carry the path's last-child flags:

```ts
const emit = (row: T, depth: number, path: boolean[]): void => {
  if (emitted.has(row.ticketId)) return;
  emitted.add(row.ticketId);
  const children = childrenOf.get(row.ticketId);
  const count = children ? children.length : 0;
  const isLast = depth > 0 && path[depth] === true;
  const guides: boolean[] = [];
  for (let k = 0; k < depth; k += 1) guides.push(!path[k + 1]);
  out.push({ ...row, subtaskDepth: depth, subtaskChildCount: count, subtaskIsLast: isLast, subtaskGuides: guides });
  if (!children) return;
  for (let i = 0; i < children.length; i += 1) {
    path[depth + 1] = i === children.length - 1;
    emit(children[i]!, Math.min(depth + 1, MAX_SUBTASK_INDENT), path);
  }
};
for (const row of rows) { if (isChild.has(row.ticketId)) continue; emit(row, 0, []); }
for (const row of rows) emit(row, 0, []);
```

- [ ] **Step 4: Run test to verify it passes** — `npx vitest run src/ui/sidebar/items.test.ts` → PASS.

- [ ] **Step 5: Commit** — `git commit -m "feat(sidebar): stamp sub-task last-child and tree-guide facts (UI-R31)"`.

---

### Task 2: Paint the guides and widen the indent in the webview

**Files:**
- Modify: `src/ui/sidebar/webview.html` (nest CSS, `.guides`/`.guide` CSS, row render)
- Test: `src/ui/sidebar/webview.test.ts`, `src/ui/sidebar/render.test.ts`, `src/ui/sidebar/renderFixtures.ts`

**Interfaces:**
- Consumes: `TicketNode.subtaskIsLast`, `TicketNode.subtaskGuides` (Task 1).
- Produces: `.guides > .guide` markup with classes `guide--line` / `guide--tee` / `guide--elbow` / `guide--off`; nest padding `calc(var(--k-space-6) * N)`.

- [ ] **Step 1: Update `webview.test.ts`** nest-rule assertions to the 12px rules and add a guides assertion:

```ts
it('steps the sub-task indent 12px per depth from the spacing token (UI-R04)', () => {
  expect(HTML).toMatch(/\.ticket\.nest1>\.row\{padding-left:var\(--k-space-6\)\}/);
  expect(HTML).toMatch(/\.ticket\.nest2>\.row\{padding-left:calc\(var\(--k-space-6\) \* 2\)\}/);
  expect(HTML).toMatch(/\.ticket\.nest3>\.row\{padding-left:calc\(var\(--k-space-6\) \* 3\)\}/);
  expect(HTML).toMatch(/\.ticket\.nest4>\.row\{padding-left:calc\(var\(--k-space-6\) \* 4\)\}/);
  expect(HTML).not.toContain('.ticket.nest5');
});

it('paints one aria-hidden guide per ancestor slot, hairline and token-only', () => {
  expect(HTML).toContain('class="guides" aria-hidden="true"');
  expect(HTML).toContain('guide--elbow');
  expect(HTML).toContain('guide--tee');
  expect(HTML).toContain('border-left:var(--k-border-w) solid var(--k-border)');
});
```

- [ ] **Step 2: Run to verify it fails** — `npx vitest run src/ui/sidebar/webview.test.ts` → FAIL.

- [ ] **Step 3: Implement the CSS + render**:
  - Replace the four `.ticket.nestN>.row` rules with the 12px step rules.
  - Add the `.guides`/`.guide` block (absolute, `pointer-events:none`; `.guide` box `width:var(--k-space-3)`; `::before` vertical hairline in `--k-border`; `::after` horizontal at `top:50%`; `.guide--line::after{content:none}`; `.guide--elbow::before{bottom:50%}`; `.guide--off` done; `.guides>.guide:nth-child(1..4)` `left: calc(var(--k-space-6) * k + var(--k-space-3))`).
  - Add `guideSpans(row)` in the inline script and prepend `guides` to `.row`.

- [ ] **Step 4: Update `renderFixtures.ts` + snapshot** — add `subtaskIsLast`/`subtaskGuides` defaults to `fixtureRow` and correct values in `subtasksState`; run `npx vitest run src/ui/sidebar/render.test.ts -u`.

- [ ] **Step 5: Run tests** — `npx vitest run src/ui/sidebar/` → PASS.

- [ ] **Step 6: Commit** — `git commit -m "feat(sidebar): hairline tree guides and 12px indent (UI-R04)"`.

---

### Task 3: Distinct sub-tree collapse glyph

**Files:**
- Modify: `src/model/tablerIcons.ts` (add glyphs)
- Modify: `src/ui/sidebar/webview.html` (`.subchev` uses the new glyph)
- Test: `src/ui/sidebar/webview.test.ts`

**Interfaces:**
- Produces: catalog entries `list-tree` (expanded) and `layout-list` (collapsed); `.subchev` renders `list-tree` when expanded, `layout-list` when collapsed, both via `karstIcon(name, 13)`.

- [ ] **Step 1: Add the failing assertion** — `webview.test.ts`:

```ts
it('gives the collapse control its own sub-tree glyph, not the row chevron', () => {
  expect(HTML).toContain("karstIcon('list-tree', 13)");
  expect(HTML).toContain("karstIcon('layout-list', 13)");
  expect(HTML).not.toMatch(/subchev[\s\S]{0,80}\$\{chev\}/);
});
```

- [ ] **Step 2: Run to verify it fails** — `npx vitest run src/ui/sidebar/webview.test.ts` → FAIL.

- [ ] **Step 3: Add the glyphs** to `TABLER_ICONS` (verbatim upstream bytes):

```ts
'list-tree':
  '<path d="M9 6h11"/><path d="M12 12h8"/><path d="M15 18h5"/>' +
  '<path d="M5 6v.01"/><path d="M8 12v.01"/><path d="M11 18v.01"/>',
'layout-list':
  '<path d="M4 6a2 2 0 0 1 2 -2h12a2 2 0 0 1 2 2v2a2 2 0 0 1 -2 2h-12a2 2 0 0 1 -2 -2l0 -2"/>' +
  '<path d="M4 16a2 2 0 0 1 2 -2h12a2 2 0 0 1 2 2v2a2 2 0 0 1 -2 2h-12a2 2 0 0 1 -2 -2l0 -2"/>',
```

- [ ] **Step 4: Use the pair in the webview** — add `subTree: karstIcon('list-tree', 13)` and `subFlat: karstIcon('layout-list', 13)` next to the other `ic` entries; render `collapsed ? ic.subFlat : ic.subTree` in the `.subchev` button; drop the now-unused `.subchev[aria-expanded="false"]{transform:rotate(-90deg)}` rotation.

- [ ] **Step 5: Run tests** — `npx vitest run src/ui/sidebar/webview.test.ts src/model/tablerIcons.test.ts` → PASS (the discovery test picks the new calls up automatically).

- [ ] **Step 6: Commit** — `git commit -m "feat(sidebar): distinct sub-tree collapse glyph (ICONS-02/07)"`.

---

### Task 4: Drop the `⊂ <parentKey>` ref when the parent is in the same list

**Files:**
- Modify: `src/ui/sidebar/webview.html` (row render parent-ref branch)
- Test: `src/ui/sidebar/webview.test.ts`

**Interfaces:**
- Consumes: `nestSubtasks` invariant — a row keeps `subtaskParentKey` but is a root (`subtaskDepth === 0`) only when its parent is NOT in the same rendered list.

- [ ] **Step 1: Update the marker test** — replace the NDL-76 assertion with:

```ts
it('shows the ⊂ parent ref only for an orphan sub-task (parent not in the list)', () => {
  expect(HTML).toContain('row.subtaskParentKey && !row.subtaskDepth');
  expect(HTML).toContain('⊂ ${esc(row.subtaskParentKey)}');
  expect(HTML).toContain('↳ ${esc(row.parentKey)}'); // follow-up unchanged
});
```

- [ ] **Step 2: Run to verify it fails** — `npx vitest run src/ui/sidebar/webview.test.ts` → FAIL.

- [ ] **Step 3: Implement** — change the row-content branch to `(row.subtaskParentKey && !row.subtaskDepth) ? <⊂ ref> : (row.parentKey ? <↳ ref> : '')`.

- [ ] **Step 4: Run tests** — `npx vitest run src/ui/sidebar/` → PASS.

- [ ] **Step 5: Commit** — `git commit -m "feat(sidebar): drop redundant ⊂ ref when the parent row is visible"`.

---

### Task 5: Full verification and visual check

**Files:** none (verification).

- [ ] **Step 1:** `npx vitest run src/ui/sidebar/ src/model/tablerIcons.test.ts` → PASS.
- [ ] **Step 2:** `npm run -s typecheck` and `npm run -s lint:react` → clean.
- [ ] **Step 3:** `npm run -s build` → clean.
- [ ] **Step 4:** `npm run -s test:visual:docker 2>&1 | tail -40` → capture before/after sidebar screenshots for the PR; update baselines only with user approval (UI README rule 5).
- [ ] **Step 5:** Mutation spot-check on the changed source: `npx stryker run --mutate src/ui/sidebar/items.ts` then `node scripts/mutationSummary.mjs` → score ≥ 85.
- [ ] **Step 6:** Commit any remaining test/rationale changes.
