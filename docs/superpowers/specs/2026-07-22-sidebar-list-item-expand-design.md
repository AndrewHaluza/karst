# Rework sidebar list-item expand — pipeline-triage peek

Ticket: 869e85qjx — [FEAT] rework list item expand

## Problem

The sidebar ticket row's expanded body today shows:

- **Stage** — a human phrase (e.g. "UAT failed"), redundant with the colored stage
  chip and the status glyph already visible on the collapsed row.
- **Ports** — usually `—` (most tickets have no running server).
- **Worktrees** — usually a single repo tag.
- **Actions** — "Open dashboard" + "Session", duplicating the hover icons.

Net: expanding a row reveals almost nothing not already on the collapsed row, so it
carries too little value to be worth the click.

## Goal

The sidebar list's unique job vs. the dashboard is **fast triage across many
tickets**. The expanded row should answer, at a glance and without opening the full
dashboard: *where is this ticket in the pipeline, and what is the next action /
what is blocking it.* Compact and informative.

## Design

### Collapsed row — unchanged

glyph · name · stage chip · hover action icons. No change.

### Expanded body — three compact lines (replaces the Stage/Ports/Worktrees trio)

**1. Mini stage rail** — five fixed milestone segments, always in this order:

```
scope · impl · uat · review · ship
```

Each segment is colored/shaped by that stage's status (from `stages[]`):

| status         | render                          |
| -------------- | ------------------------------- |
| passed         | filled ● in the stage color     |
| running        | half ◐, pulsing                 |
| failed         | filled ● in failed-red          |
| pending/future | hollow ○                        |
| skipped        | dashed / dimmed                 |

The **current** stage segment gets a ring/emphasis.

`fix` (a retry loop off review, not a linear step) and `done` (terminal) are **not**
rail segments — the rail stays a stable-width five. Their nuance surfaces in line 2.
When the current stage is `fix`, the rail emphasizes the `review` segment and line 2
reads "Fixing…".

**2. Next-action line** — the one actionable sentence, tone-colored:

- needs-you → `⚠ Waiting on you`
- current stage failed → `⚠ <Stage> failed: <reason> · attempt N`
  (reason from the current stage's `verdict` column, which stores `verdict.reason`)
- running → `<Activity>…` (e.g. "Implementing…", "Fixing…")
- terminal pass → `Shipped`
- otherwise → the existing `stageBadge.label` (e.g. "Awaiting review", "Not scoped",
  "Not started")

**3. Meta line** — dim, single line, each token shown only when present, `·`-joined:

```
<model> · <repoA>+<repoB> · :3000, :3001
```

Empty tokens are omitted entirely rather than rendered as `—` rows. If every token
is empty the line is omitted.

### Actions — unchanged

`Open dashboard` (primary) + `Session` for active tickets; `Unarchive` + `Delete`
for archived. Labeled buttons kept for discoverability alongside the hover icons.

## Data model changes

All additions are pure, vscode-free, and unit-testable — they extend the existing
row model in `src/ui/sidebar/items.ts` (`TicketNode`) and `state.ts` (`TicketRow`).
No schema change (all data already lives in `stages[]` and the ticket row).

Add to `TicketNode` (built in `buildTicketNodes` from `TicketWithStages`):

- `rail: RailCell[]` where `RailCell = { key: StageKey; title: string; status: StageStatus; current: boolean }`
  — one cell per milestone in `['scope','impl','uat','review','ship']`, status read
  from the matching `stages[]` row (fallback `pending` when absent).
- `reason: string | null` — the current stage's `verdict` (the failure reason), else null.
- `attempt: number` — the current stage's `attempt`.
- `model: string | null` — `ticket.model` (no manifest resolution here; null = inherit).

The webview renders lines 1–3 purely from these fields plus the existing
`servers`/`worktrees` on `TicketRow`. No new host→webview message types.

## Testing (TDD, RED→GREEN)

`src/ui/sidebar/items.test.ts`:

- rail: builds five cells in fixed order; each cell's status mirrors the matching
  `stages[]` row; `current` true only on `stageCurrent`; absent stage row → `pending`.
- reason/attempt: pulled from the current stage; failed stage exposes its `verdict`
  as `reason`; non-failed → whatever `verdict` holds / null.
- model passthrough.
- edge: ticket with no `stageCurrent` (Not started) → no `current` cell, all pending.

Webview render logic (line assembly, empty-token collapsing) covered in
`src/ui/sidebar/webview.test.ts` where the existing body assertions live.

## Non-goals

- No change to the collapsed row, facets, search, or hover actions.
- No manifest model resolution in the sidebar (dashboard's job).
- No `fix`/`done` as linear rail segments.
- No new persisted state or DB columns.
