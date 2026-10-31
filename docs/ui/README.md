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
   Below 700 px (split editor groups, down to the 320 px floor) also read **group E**
   (`ui:UI-R49`..`ui:UI-R56`) and `RESPONSIVE-DENSITY.md` (tiers `ui:RD-TIERS`, ladders `ui:RD-LADDERS`).
2. **Rules for the touched controls** — the other `UI-RULES.md` blocks, plus
   `UI-INVARIANTS.md` keys that apply.
3. **Layout primitives** — `DESIGN-SYSTEM.md` `ui:LAYOUT-PRIMITIVES`, then the
   token and primitive blocks you use.
4. **Variants** — add or extend the view's variants in `tests/visual/variants.ts` (`ui:UI-R57`, `ui:VISUAL-VARIANTS`) and record baselines. A change under `src/ui/<view>/**` that touches neither that view's variants nor its baselines gets a review warning (`tests/visual/variantTouch.ts`).
5. **Verify** — run `npm run -s test:visual:docker 2>&1 | tail -40` after any webview change (CI runs it as the `visual` job: a PR's own added/changed baseline that fails is blocking, pre-existing diffs stay advisory; judge visual failures only from the docker run, never host `test:visual`). A host without Docker prints `SKIPPED` and exits 0 — that is NOT a visual pass; run the wrapper on a Docker host. `npm run test:layout` is advisory and fast on the host; the final
   check and any ledger change go through `npm run test:layout:docker`
   (`test:visual:docker` for baselines).
6. **Screenshot changes need user approval.** Never edit baselines or the layout
   ledger (`tests/visual/layout-known-failures.json`) to pass a gate; the ledger
   shrinks only via `npm run test:layout:docker:prune`.
7. **New dashboard `data-act`.** Every new `data-act` needs a parity case in `COVERED` (`src/ui/dashboard/parity/parityCases.ts`) or a `NOT_COVERED` reason; the unit test `src/ui/dashboard/parity/coverage.test.ts` fails with the exact hint otherwise.

Cite the rule id in the commit when a change exists to satisfy one (UI-R35).
END_DOC_BLOCK: [@ui:README-ORDER]

## [@ui:README-WHEN] When to read what

| Doc | Read when |
|---|---|
| `UI-RULES.md` | Always: group L first, then rules for the controls you touch |
| `RESPONSIVE-DENSITY.md` | Any width-dependent layout; collapse ladders, tiers, backlog. Evidence in `responsive-audit/README.md`, visual in `RESPONSIVE-DENSITY-EXAMPLE.html` |
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

## [@ui:README-FIXTURES] Fixtures: hand-written state vs built from store

Question this answers: does a store ordering/query change touch a fixture or a
visual baseline? Only through the ONE runtime coupling below. No fixture opens
SQLite (`openStore`) or reads the store; all are hand-written data typed by the
view's production state shape. The visual sweep seeds from them via
`tests/visual/corpora.ts`.

| Fixture file | Kind | Note |
|---|---|---|
| `src/ui/sidebar/renderFixtures.ts` | hand-written state | `SidebarState` rows/PRs/planning literals; no store import |
| `src/ui/dashboard/renderFixtures.ts` | hand-written state | Literals; reuses model helpers (`buildStageRail`, `boundedEvidenceRows`), type-only store imports |
| `src/ui/dashboard/app/fixtures/artifactFixtures.ts` | hand-written state | `ArtifactSummary` literals (plus `*Kit.tsx`/`persistTrace.ts` test kits in that folder) |
| `src/ui/resources/renderFixtures.ts` | hand-written state | Hand-written inventory fed to the pure `buildServersState`; type-only store imports |
| `src/ui/usage/renderFixtures.ts` | hand-written state | Imports the `USAGE_SORTS` constant from `store/tokenUsageQuery.ts`: changing sort ids or their order changes the sort control and baselines. Rows are literals, so query ordering changes do not |
| `src/ui/gettingStarted/renderFixtures.ts` | hand-written state | Uses `TUTORIAL_STEPS` from `./state.js` (not store) |
| `src/ui/diffs/renderFixtures.ts` | hand-written state | Pure data, reserved ticket ids 900001–999999 |
| `src/ui/settings/app/testFixtures.ts` | hand-written state | `buildSettingsState` over `manifest/fixtures.ts` literals |
| `tests/visual/corpora.ts` MINIMAL_SETTINGS / MINIMAL_TICKET_FORM | hand-written state | Inline seeds for `settings` and `ticketForm` (no renderFixtures module) |

Built from store: none among UI fixtures. Store-seeded fixtures are non-UI:
`src/uatHost/fixtures.ts` (seeds for UAT host stores) and
`src/store/fixtures/fixDeliveryHarness.ts`. A store change that alters
displayed order or query results reaches a baseline only after the
state-builder (`state.ts`) changes; the fixture literals stay as written.
END_DOC_BLOCK: [@ui:README-FIXTURES]

## [@ui:README-GAPS] Known gaps

- No z-index scale (deferred: no T601 symptom).
- Existing settings CSS breakpoints (1024/768/800/700px) predate the tiers and
  migrate over time via `BREAKPOINT_PINNED_FILES`.
- The legacy settings `webview.html` still has `em` media queries.
END_DOC_BLOCK: [@ui:README-GAPS]
