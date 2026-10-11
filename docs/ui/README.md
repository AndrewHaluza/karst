<!-- AGENT INSTRUCTIONS:
This file uses an agent-optimized block format. DO NOT read this file entirely.
1. TABLE OF CONTENTS: Run this to list all available keys:
  grep -F "## [@" docs/ui/README.md

2. EXTRACT A RULE: Run this to read a specific block (Example for ID 'ui:README-ORDER'):
  awk "/^## \[@ui:README-ORDER\]/,/END_DOC_BLOCK: \[@ui:README-ORDER\]/" docs/ui/README.md
-->
# docs/ui — start here

Every UI ticket (planner, implementer, UAT tester, reviewer) follows this order.
Read keyed blocks only (`grep -F "## [@" <file>`, then extract one block); never
read a whole file.

## [@ui:README-ORDER] Read order

0. **Prototype linked?** Open it and list its regions (`data-region` names), their
   order and stacking. They are binding (`ui:UI-R39`).
1. **Group L** — `UI-RULES.md` `ui:UI-R39`..`ui:UI-R48`: layout and placement.
2. **Rules for the touched controls** — the other `UI-RULES.md` blocks, plus
   `UI-INVARIANTS.md` keys that apply.
3. **Layout primitives** — `DESIGN-SYSTEM.md` `ui:LAYOUT-PRIMITIVES`, then the
   token and primitive blocks you use.
4. **Verify** — `npm run test:layout` (advisory, fast on the host); the final
   check and any ledger change go through `npm run test:layout:docker`
   (`test:visual:docker` for baselines).
5. **Screenshot changes need user approval.** Never edit baselines or the layout
   ledger (`tests/visual/layout-known-failures.json`) to pass a gate; the ledger
   shrinks only via `npm run test:layout:docker:prune`.

Cite the rule id in the commit when a change exists to satisfy one (UI-R35).
END_DOC_BLOCK: [@ui:README-ORDER]

## [@ui:README-WHEN] When to read what

| Doc | Read when |
|---|---|
| `UI-RULES.md` | Always: group L first, then rules for the controls you touch |
| `DESIGN-SYSTEM.md` | Tokens, primitives, layout primitives |
| `STYLE-GUIDE.md` | Composition choices; `ui:SG-25` is the review checklist |
| `UI-INVARIANTS.md` | Rationale, title keys, React views, Getting Started |
| `ICONS.md` | Any icon |
| `VISUAL-COVERAGE.md` | What the sweep and layout gate prove, and what is manual |
| `KARST-UI-CATALOG.html` | Rendered reference of primitives |
END_DOC_BLOCK: [@ui:README-WHEN]

## [@ui:README-HISTORICAL] Historical — not guidance

`V3-CONFORMANCE-GAPS.md`, `REMEDIATION-PLAN.md`, `inside-redesign-designer-handoff.md`
and `.html`, `PRESETS-REDESIGN-PREVIEW.html`. Kept for history; do not follow them.
END_DOC_BLOCK: [@ui:README-HISTORICAL]

## [@ui:README-VOCAB] Vocabulary shared with the layout gate

Check letters a–i, width tiers ≥1000 / 700–999 / ≤699
(`src/ui/layout/layoutBreakpoints.ts`), `data-region` landmarks, and the ledger
above. If the gate code has not landed, these docs describe the contract it
implements.
END_DOC_BLOCK: [@ui:README-VOCAB]

## [@ui:README-GAPS] Known gaps

- No z-index scale (deferred: no T601 symptom).
- Existing settings CSS breakpoints (1024/768/800/700px) predate the tiers and
  migrate over time via `BREAKPOINT_PINNED_FILES`.
- The legacy settings `webview.html` still has `em` media queries.
END_DOC_BLOCK: [@ui:README-GAPS]
