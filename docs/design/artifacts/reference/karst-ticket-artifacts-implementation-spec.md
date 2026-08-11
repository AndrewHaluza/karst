# Karst Ticket Artifacts — Product & UX Implementation Specification

## Status

**Design status:** Finalized for implementation  
**Surface:** Karst ticket dashboard (VS Code webview)  
**Reference prototype:** `karst-artifacts-finalized.html`

---

## 1. Summary

Karst tickets can produce durable outputs during Scope, Implement, UAT, Review, and Ship. These outputs need to remain discoverable after the producing run completes, without turning the ticket dashboard into a file browser or creating additional VS Code tabs/panes.

The finalized solution is a **semantic Artifacts shelf embedded in the ticket dashboard**, with in-webview navigation to:

1. a specific artifact detail, or
2. a complete artifact index.

The core navigation model is:

```text
Ticket dashboard
  ├─ click artifact preview → Artifact detail
  └─ View all → Artifacts index → Artifact detail
```

Artifacts stay inside the ticket’s existing webview. They do **not** open a second Karst webview, persistent drawer, split view, or dedicated VS Code editor group.

Underlying files can still be opened in a normal VS Code editor when the user explicitly requests the raw representation.

---

## 2. Product Decision

### One VS Code tab = one ticket

Karst users may have several tickets open concurrently. The artifact interaction must not multiply the amount of editor/tab state.

Do not create patterns such as:

```text
AUTH-284 dashboard
AUTH-284 artifacts
PAY-113 dashboard
PAY-113 artifacts
...
```

Instead, each ticket owns its navigation state inside its existing webview:

```text
[ AUTH-284 ] [ PAY-113 ] [ UI-88 ] [ API-41 ] [ DB-29 ]
```

Within `AUTH-284`, the user can move between:

```text
Ticket
Artifacts index
Artifact detail
```

without affecting VS Code’s editor layout.

---

## 3. Why Artifacts Exist

Artifacts represent **durable outputs worth returning to after a run finishes**.

Examples:

- Research notes
- Implementation plan
- Implementation summary
- Static UAT report
- AI UAT report
- Screenshots or other test evidence
- Review report
- Patch
- PR summary

Artifacts are **not**:

- live stdout
- agent chat messages
- tool calls
- temporary scratch files
- raw execution logs
- intermediate reasoning
- process status

Those remain part of the execution/run experience, primarily represented in **Inside**.

### Product boundary

**Inside answers:**  
> What is happening now?

**Artifacts answer:**  
> What durable output did this ticket produce?

This distinction should remain strict.

---

## 4. Dashboard Behavior

### 4.1 Zero artifacts

If the ticket has no durable artifacts, do not render an empty Artifacts section.

```text
Stages
Inside
Ticket details
```

No placeholder, empty-state card, or disabled section should be shown.

### 4.2 First artifact created

As soon as the first durable artifact is stored, the Artifacts shelf becomes visible on the ticket dashboard.

The shelf remains present for the lifetime of the ticket while at least one artifact exists.

### 4.3 Shelf structure

The shelf contains:

- section title: `Artifacts`
- top-level semantic artifact count
- up to 3 high-value artifact previews
- `View all N ›`

Example:

```text
ARTIFACTS  6                                      View all 6 ›

[ Plan               ]
  3 implementation tasks

[ UAT report         ]
  ✓ Passed · 18/18

[ Review             ]
  2 findings · 1 resolved
```

### 4.4 Shelf previews are semantic, not file-based

Prefer:

```text
Plan
UAT report
Review
PR summary
```

Do not expose raw filenames on the shelf:

```text
plan.md
uat-report.json
review-v2.md
```

Raw representations belong inside artifact detail.

---

## 5. Shelf Preview Selection

The shelf should not simply show:

- most recent artifacts, or
- one artifact from every stage.

That causes unstable ordering and can prioritize low-value artifacts.

Use **semantic priority**.

Recommended default priority:

1. current implementation plan
2. latest verification/UAT result
3. latest review result
4. latest Ship/PR result
5. implementation summary
6. research output
7. screenshots/supporting evidence
8. raw/attachment-like artifacts

The exact score can be implementation-defined, but the UX requirement is:

> The three previews should represent the most useful current ticket outputs, and their ordering should remain stable unless a more important semantic output becomes available.

### Completed tickets

On completed tickets, Ship/PR output may outrank Plan.

Example:

```text
PR summary
UAT report
Review
```

This may be implemented with lifecycle-sensitive priority.

---

## 6. Artifact Count Semantics

`Artifacts N` counts **top-level semantic artifacts**, not files, versions, or individual resources.

Example:

```text
UAT report
  ├─ uat-report.json
  ├─ uat-report.md
  └─ screenshots/
```

This can still be one semantic artifact if screenshots are treated as resources belonging to the report.

If screenshots are intentionally modeled as their own semantic artifact, they count separately.

The count must never increase simply because:

- a new version was generated
- another raw representation was added
- a directory gained more files

### Version rule

Regenerating the same logical artifact creates a new version of that artifact rather than a new top-level artifact.

---

## 7. Navigation Model

There are exactly three in-webview surfaces:

### 7.1 Ticket dashboard

Primary ticket surface.

### 7.2 Artifacts index

Opened by:

```text
View all N ›
```

Header:

```text
← Ticket

AUTH-284 · Add passkey login
Artifacts · 6
```

Artifacts are grouped by producing workflow stage.

Example:

```text
SCOPE
Research notes

IMPLEMENT
Plan
Implementation summary

UAT
UAT report
Screenshots

REVIEW
Review
```

Do not render empty stage headings.

### 7.3 Artifact detail

Opened either:

- directly from a shelf preview, or
- from the Artifacts index.

The Back target depends on origin.

#### Opened from dashboard

```text
Dashboard → UAT report
```

Back returns to:

```text
Ticket
```

#### Opened from index

```text
Dashboard → Artifacts → UAT report
```

Back returns to:

```text
Artifacts
```

Back behavior must be deterministic.

---

## 8. Back and Escape Behavior

### Explicit Back

Artifact index:

```text
← Ticket
```

Artifact detail opened from dashboard:

```text
← Ticket
```

Artifact detail opened from index:

```text
← Artifacts
```

### Escape

`Esc` mirrors one Back step:

- Artifact detail → its origin
- Artifacts index → Ticket
- Ticket dashboard → no artifact-navigation action

Do not create a separate modal close concept.

---

## 9. Scroll Preservation

Each in-webview surface should preserve its own scroll state for the active ticket session.

Example:

1. user scrolls ticket dashboard halfway down
2. opens UAT report
3. returns to Ticket
4. dashboard should restore the previous scroll position

Similarly:

```text
Artifacts index scroll position
Artifact detail scroll position
```

should not reset unnecessarily during navigation.

This is especially important because the dashboard may contain a large Inside block.

---

## 10. Artifacts Index

### Grouping

Default grouping is:

```text
Scope
Implement
UAT
Review
Ship
```

Only show groups containing artifacts.

### Row structure

Each row should communicate:

- semantic artifact name
- one useful secondary summary
- current state/value if relevant
- navigation affordance

Example:

```text
UAT report
18 passed · 0 failed · current                Passed  ›
```

Avoid displaying file path, file size, producer, version, timestamp, and repo all at once.

The index is not a metadata table.

### Filters/search

Do not include permanent stage filters or search for normal artifact counts.

Grouping is sufficient for the expected small/medium ticket artifact set.

Search/filtering can be added later if real tickets routinely accumulate large artifact collections.

---

## 11. Artifact Detail Hierarchy

Artifact detail should be **semantic first, files last**.

General structure:

```text
← Ticket / ← Artifacts

Artifact name

Semantic result / summary
Relevant metrics

Artifact-specific content

Details / provenance

Underlying files
```

### Example — UAT

```text
UAT report

✓ Verification passed
Current for the latest implementation revision.

18 passed
0 failed
42 sec

Tests
✓ Login with passkey
✓ Fallback password login
✓ Revoked credential handling

Details
Stage        UAT
Produced by  Karst UAT agent
Version      v3 · current

Underlying files
uat-report.json                    Open in editor ↗
```

### Example — Review

```text
Review

2 findings need attention

HIGH
Credential cache is not cleared...

MEDIUM
Missing analytics event...

Details
Stage        Review
Produced by  Review agent
Version      v2 · current

Underlying files
review.md                          Open in editor ↗
```

---

## 12. Raw File Behavior

Raw representations are intentionally secondary.

Examples:

- `.md`
- `.json`
- `.patch`
- screenshot folder
- generated report files

Action:

```text
Open in editor ↗
```

This can invoke the extension host and open the underlying workspace/file URI in a normal VS Code editor.

Opening the raw file is a deliberate escape from the semantic artifact UI into VS Code’s native file/editor model.

Do not automatically open raw files when clicking a semantic artifact.

---

## 13. Freshness / Staleness

This is a required part of the artifact model.

A verification or review artifact may still exist while no longer validating the current implementation.

Example:

1. implementation completes
2. UAT passes
3. implementation changes again
4. UAT has not been rerun

The UAT report is now **stale**.

Do not continue presenting it simply as:

```text
✓ 18/18 passed
```

Instead show:

```text
UAT report
18/18 passed · stale
```

Detail:

```text
Passed, but no longer current

Implementation changed after this verification.
Rerun UAT before treating this result as evidence for the current code.
```

### Important distinction

Domain result:

```text
UAT failed because 3 tests failed
```

is different from:

```text
Artifact could not be loaded/stored/rendered
```

These must not share the same failure state.

---

## 14. Artifact Identity

Artifact identity must support versions and repo scope.

A logical identity should be based on fields conceptually similar to:

```text
ticket
stage
kind
scope
```

Example:

```text
kind: uat.static_report
scope: repo:web
```

This allows:

```text
UAT report · web
UAT report · api
```

to be separate semantic artifacts while:

```text
UAT report · web · v1
UAT report · web · v2
```

remain versions of the same artifact.

### Suggested conceptual model

```ts
Artifact {
  id
  ticketId
  stage
  kind
  scope
  title
  summary
  status
  freshness
  producer
  currentVersion
  versions[]
  resources[]
  createdAt
  updatedAt
}
```

Exact persistence/schema design is implementation-owned.

---

## 15. Multi-Repo Tickets

Repo context is conditional.

For a single-repo or ticket-wide artifact:

```text
UAT report
```

For ambiguous multi-repo output:

```text
UAT report · web
UAT report · api
```

Do not permanently show repo labels when they add no disambiguation value.

### Index hierarchy

Default hierarchy remains **stage first** because Karst is stage-oriented.

For multi-repo tickets:

```text
UAT

web
  UAT report
  Screenshots

api
  UAT report
```

A flat list with repeated repo badges is acceptable for small sets, but the UI should be able to introduce repo sub-grouping when repetition becomes visually noisy.

---

## 16. "New" / Unread State

Persistent unread semantics are **not part of V1**.

Do not build:

```text
Artifacts · 2 new
```

as a durable per-user read state.

It introduces unnecessary questions around:

- when it clears
- synchronization
- multiple windows
- multiple machines
- session ownership

If newly created artifacts need emphasis, use transient visual treatment only.

Freshness/staleness is a more important state than unread/new.

---

## 17. VS Code Webview Constraints

The ticket dashboard is a VS Code webview.

The design must therefore work within the width of the current editor group, which may vary substantially as users:

- resize the VS Code window
- open the sidebar
- open the panel
- split editor groups
- move ticket tabs
- use several ticket webviews at once

### Explicitly rejected patterns

Do not implement the primary artifact interaction as:

- persistent side drawer
- split artifact inspector
- second Karst editor tab
- second Karst webview
- artifact panel that modifies VS Code editor layout

These patterns create excessive state when several ticket dashboards are open.

### Responsive behavior

The finalized navigation model does not require a special narrow-layout interaction.

All three surfaces:

```text
Ticket
Artifacts index
Artifact detail
```

occupy the same webview width and should naturally reflow.

Recommended responsive changes:

- 3 shelf preview cards on wide layouts
- 2 cards where necessary
- 1-column cards on narrow editor groups
- hide low-priority secondary ticket status before truncating core artifact content

---

## 18. Accessibility

Required baseline:

- all artifact previews are keyboard-focusable
- artifact index rows support Enter/Space
- visible focus state
- Back is a real button
- semantic statuses are not communicated by color alone
- `Esc` supports Back navigation
- text truncation must retain accessible labels/titles where necessary

Avoid making a full row clickable only through pointer handlers without keyboard support.

---

## 19. Loading & Error States

### Shelf loading

Do not block the entire ticket dashboard while loading artifact metadata.

If artifact metadata is not yet available, either:

- keep the shelf absent until resolved, or
- render a lightweight local skeleton only for the shelf area

### Artifact detail loading

Artifact detail may show a local loading state while fetching the artifact payload.

### Artifact unavailable

If metadata exists but payload cannot be loaded:

```text
UAT report

Could not load this artifact.

[ Retry ]

Underlying file may still be available:
uat-report.json    Open in editor ↗
```

Do not convert this into:

```text
UAT failed
```

because artifact availability and domain result are different concepts.

---

## 20. Lifecycle Behavior

The same core component is used through the ticket lifecycle.

### Active ticket

Typical priorities:

```text
Plan
UAT
Review
```

### Ship

Possible shelf:

```text
UAT
Review
PR / Patch
```

### Done

Possible shelf:

```text
PR summary
UAT report
Review
```

V1 should keep the layout structurally stable across lifecycle states.

Only semantic preview priority needs to adapt.

Do not implement a separate Done-ticket artifact layout yet.

---

## 21. Non-Goals for V1

Do not include the following in the first implementation unless required by existing backend behavior:

- full-text artifact search
- persistent unread tracking
- tags/favorites
- artifact pinning
- user-configurable shelf order
- separate artifact VS Code tabs
- persistent side inspector
- split-screen artifact comparison
- drag-and-drop artifact organization
- arbitrary file browser
- complex stage filters
- lifecycle-specific page redesign

These can be revisited after real artifact usage data exists.

---

## 22. Recommended Event Contract

The webview implementation will likely need extension-host messages similar to:

```ts
artifact.list(ticketId)
artifact.get(artifactId)
artifact.openResource(resourceUri)
artifact.retry(artifactId)
```

Optional future actions:

```ts
artifact.compareVersions(artifactId)
artifact.export(artifactId)
```

This section is illustrative; actual transport naming can follow existing Karst conventions.

---

## 23. UI State Model

Minimal client state:

```ts
type ArtifactViewState =
  | { view: 'ticket' }
  | { view: 'index' }
  | {
      view: 'detail'
      artifactId: string
      origin: 'ticket' | 'index'
    }
```

Also retain per-view scroll positions:

```ts
{
  ticketScrollTop,
  indexScrollTop,
  detailScrollTopByArtifactId
}
```

Navigation:

```text
Ticket → Detail(origin=ticket)
Ticket → Index
Index  → Detail(origin=index)

Detail(origin=ticket) → Ticket
Detail(origin=index)  → Index
Index → Ticket
```

---

## 24. Acceptance Criteria

### Dashboard

- [ ] Artifacts section is absent when the ticket has zero artifacts.
- [ ] Section appears after the first durable artifact exists.
- [ ] Shelf shows the top-level semantic artifact count.
- [ ] Shelf shows no more than 3 preview artifacts.
- [ ] Preview selection uses semantic priority rather than simple recency.
- [ ] Preview cards do not expose raw filenames.
- [ ] Clicking a preview opens that artifact detail inside the same webview.
- [ ] `View all N` opens the Artifacts index inside the same webview.

### Artifact index

- [ ] Artifacts are grouped by producing stage.
- [ ] Empty stage groups are omitted.
- [ ] Rows expose semantic name + concise useful summary.
- [ ] Index does not behave like a generic file browser.
- [ ] Rows are keyboard accessible.
- [ ] Opening a row navigates to artifact detail.

### Artifact detail

- [ ] Semantic result is shown before raw files.
- [ ] Relevant structured information is displayed for known artifact kinds.
- [ ] Producer/version metadata is secondary.
- [ ] Underlying files are last.
- [ ] Raw files can be opened in a normal VS Code editor.
- [ ] Artifact load failure is distinct from domain/test failure.

### Navigation

- [ ] Direct Dashboard → Detail returns to Ticket.
- [ ] Dashboard → Index → Detail returns Detail → Index → Ticket.
- [ ] `Esc` mirrors Back.
- [ ] No additional Karst VS Code tab is created.
- [ ] No split pane or persistent artifact drawer is created.
- [ ] Ticket/index scroll positions are preserved during navigation.

### Freshness

- [ ] Verification/review artifacts can be marked stale.
- [ ] Stale artifacts retain their historical result.
- [ ] Stale artifacts clearly state they no longer validate the latest implementation.
- [ ] New versions do not inflate the semantic artifact count.

### Multi-repo

- [ ] Repo context is shown only when needed for disambiguation.
- [ ] Same-kind artifacts for different repos can coexist independently.
- [ ] Versions remain associated with the correct repo-scoped artifact.

### Responsive / webview

- [ ] Shelf reflows cleanly for narrow editor groups.
- [ ] Full artifact index and detail remain usable without an internal split pane.
- [ ] UI does not assume full browser-window width.

---

## 25. Final Product Principle

The artifact experience should feel like **part of the ticket**, not a parallel application.

The user should always understand:

```text
I am still inside AUTH-284.
I am inspecting an output produced by AUTH-284.
One Back action returns me toward AUTH-284.
```

The stable product hierarchy is:

```text
Ticket
  └─ Artifacts
       └─ Artifact
            └─ Underlying VS Code file (only when explicitly opened)
```

This should remain the governing model during implementation.
