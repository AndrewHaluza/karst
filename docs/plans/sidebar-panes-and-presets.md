# Sidebar: Planning/Tickets panes, filter presets, draft collapse

Status: agreed in brainstorm, not started. Two changes, in this order.

## Step 1 — Migrate the sidebar to React (no behaviour change)

`src/ui/sidebar/webview.html` (vanilla, ~1.5k lines) becomes a React app following the
Settings reference pattern (`src/ui/settings/app/**`): mounted once into `#root`,
`app/main.tsx` owns the single `acquireVsCodeApi()`, tests use `renderWebviewReady('sidebar')`.

Rules from `CLAUDE.md` / `docs/ui/README.md`: read it first; no baseline or layout-ledger
edits; parity floor holds; visual (`npm run -s test:visual:docker`), unit and integration
gates pass. Migration only: same DOM semantics, same messages (`messages.ts`), same
`state.ts` snapshot. Keep files under ~400 lines (split by Planning tree, ticket rows,
toolbar, context menu).

## Step 2 — Redesign (React only)

### Layout
- Toolbar keeps resources, token usage, settings. The two create buttons are removed.
- Below the search box: two panes, **Planning** and **Tickets**.
- Each pane header is always visible (even when empty): chevron (collapse), title, count,
  `+` (start planning session / create ticket). Planning also keeps "collapse all".
- Each pane scrolls independently. Collapsing one gives its height to the other. Collapsed
  state is remembered per window (view state only, never posted to the host).
- One search box filters both panes.

### Filters
- The chip row is replaced by a funnel menu in the **Tickets** header with single-select
  presets: All (default), Needs attention (needs you + blocked), In progress, Done, Archived.
  A dot on the funnel shows an active preset.
- "N need you · M blocked" line under the Tickets header, shown only on All and only when the
  counts are above zero; click applies "Needs attention".
- Presets apply to Tickets only. Archived planning sessions get a "show archived" toggle in
  the Planning header.

### Drafts
- Pending drafts always visible. Accepted drafts collapse behind "N accepted ▸" on the
  session row; search still matches them.
- Finished sessions (all drafts accepted, no live terminal) auto-archive after
  `archivePlanningAfterDays` (default 3).

### New setting: `archivePlanningAfterDays`
Mirror `archiveDoneAfterDays` end to end: `src/manifest/types.ts`, `schema.ts` (positive
whole number validator), `write.ts` (default), `manifestResolve.ts`, Settings → General
(`GeneralSection.tsx`, `sections.ts`), `karst.example.yml`, boot sweep in
`src/extension/ops/bootSweeps.ts`, and the new-field checklist `arch:FIELDCHK` in
`docs/arch/manifest-and-settings.md`. Store change follows `arch:SCHEMA-CHECK`.

### Gates
Strict TDD. Anything under `src/extension/**` keeps the Stryker score >= 85.
Run the visual docker sweep after the webview changes.

## Mockup
Interactive before/after mockup was shared in the session (not committed).
