# Merge-check presentation on the dashboard

Ticket: 869echj3u — [FIX] improve message about MC

## Problem

The PR panel renders one repo's mergeability as a single ellipsized line:

```
● conflicted (4 files: CLAUDE.md, src/agent/modelCatalog.test.ts, src/mod…
```

`.mg .mgtext` is `white-space:nowrap` with `text-overflow:ellipsis`, and the string
it places (`summarizeMergeCheck`) packs the verdict, the count, and up to five full
paths into that one slot. At the panel's real width the paths are the first thing
truncated, so the row states a problem and withholds the only detail that makes it
actionable. The `unknown` case is worse: it interpolates git's own error prose,
which is unbounded, into the same nowrap slot.

Two facts the store already holds never reach the panel at all: `baseRef` (what the
branch was compared against) and `checkedAt` (when the answer was obtained). A merge
verdict is current state, not evidence — the store's own doc comment says an old row
is "a wrong answer stated with full confidence" — so a panel that shows the verdict
without its age omits the fact that decides whether to trust it.

The garbled file list in the ticket text (`Auto-merging CLAUDE.md, CONFLICT
(content): Merge conflict in CLAUDE.md, …`) was a parsing defect, fixed in 7acd6be.
What remains is presentation.

## Scope

The dashboard PR panel only. `summarizeMergeCheck` keeps its current wording and its
five-file cap, because the ship strip (`model/inside/index.ts`) and the rendered
ticket context (`karst context`, read by the agent) both place it in a genuinely
one-line slot. Those two surfaces are unchanged by this work.

## Architecture

```
store/mergeChecks.ts  (MergeCheckRow, incl. baseRef + checkedAt)
        │
        ▼
model/mergeCheckPanel.ts   buildMergeCheckPanelRows(checks, now)   ← new, pure
        │
        ▼
ui/dashboard/state.ts      DashboardState.mergeChecks
        │
        ▼
ui/dashboard/webview.html  mergeLine()  — places strings, formats nothing
```

A new module rather than a second export from `model/mergeCheckView.ts`: that
module's stated job is keeping the panel and the CLI from describing one
three-valued fact two different ways, and dashboard-only copy inside it would
undercut exactly that. The split mirrors `model/prPanelView.ts`, which is the same
shape (one pure host-side module per panel surface, its own test file).

`now` is injected, not read from the clock, so the module stays pure and testable —
the same convention `model/inside/types.ts` uses for elapsed times.

### Row shape

`MergeCheckPanelView` in `ui/dashboard/state.ts` is replaced by
`MergeCheckPanelRow`, exported from the new module:

```ts
export interface MergeCheckPanelRow {
  /** The repository path — the row's IDENTITY, what `resolve-conflicts` names. */
  repo: string;
  /** Drives the dot's shape and colour, and whether Resolve is offered. */
  state: MergeState;
  /** `conflicted · 4 files · vs develop · 4m ago`. Parts omitted when absent. */
  headline: string;
  /** `4 conflicting files` | `why karst could not tell` | '' when there is no body. */
  detailsLabel: string;
  /** Conflicting paths, verbatim and uncapped. Empty for clean and unknown. */
  files: readonly string[];
  /** Git's own words, for `unknown` only. '' otherwise. */
  reason: string;
  /** Absolute locale stamp for the title attribute. '' when unparseable. */
  checkedTitle: string;
}
```

`summary` leaves the dashboard state; nothing else reads it.

## Wording rules

The headline is parts joined with ` · `, each part omitted entirely when the fact is
absent — never a placeholder, matching how `prMetaLine` already degrades:

1. The state word: `clean`, `conflicted`, or `unknown`.
2. `4 files` / `1 file` — conflicted only, and omitted when the list is empty.
3. `vs <baseRef>` — omitted when the store has no base ref.
4. The age: `just now` (< 1m), `4m ago` (< 1h), `2h ago` (< 24h), `3d ago` beyond.

`detailsLabel` is non-empty only when there is a body to open:

| state | condition | label |
|---|---|---|
| conflicted | `files.length > 0` | `4 conflicting files` (singular at 1) |
| unknown | `reason` non-empty | `why karst could not tell` |
| any other case | — | `''` |

An empty `detailsLabel` renders no disclosure at all, rather than an empty one.

Git prose never enters the headline. It is unbounded text, and putting unbounded
text in a bounded slot is the defect this design removes; it belongs in the wrapped
disclosure body where it is readable and selectable.

Age uses a coarse formatter local to this module, not `formatDuration` from
`model/inside/types.ts`. `formatDuration` renders `4m 12s`, and second-level
precision on a stamp that only refreshes when the host pushes state is precision the
value does not have.

The absolute stamp is carried alongside as `checkedTitle` (via `formatPrStamp`, the
formatter the PR rows already use) and rendered as the headline's `title`. The
relative label is what a reader scans; the absolute one is what stays true after the
panel has sat open and the relative label has drifted.

## Webview

`.mg` becomes a block: a headline row (dot · text · Resolve button) with an optional
`<details>` beneath it.

```
● conflicted · 4 files · vs develop · 4m ago      [Resolve conflicts]
  ▸ 4 conflicting files

  ▾ 4 conflicting files                     ← opened
     CLAUDE.md
     src/agent/modelCatalog.test.ts
     src/model/mergeCheckView.ts
     src/ui/dashboard/webview.html

● clean · vs develop · 4m ago

○ unknown · vs develop · 4m ago
  ▸ why karst could not tell
     fatal: not a valid object name develop
```

The disclosure is styled off `.pcms`, the PR-comments collapse already in this
panel — same interaction vocabulary, no new one. The file list is monospace, one
path per line, `word-break:break-all` so a long path wraps instead of overflowing,
and the body is `max-height` + `overflow-y:auto` so a forty-file conflict cannot
push the rest of the panel off screen.

The headline keeps `nowrap` + ellipsis as a backstop; it is now bounded content, so
the ellipsis should not fire in practice.

Resolve is still gated on `m.state === 'conflicted'` and still carries `data-repo`.
Both are pinned by an existing test and must not move: the button is an affordance
for one verdict, and the host re-validates the repo on receipt regardless.

Every interpolated value goes through `esc()` — paths and git prose both originate
outside karst.

## Edge cases

- **No check for a repo** — renders nothing. Never asked is not clean; unchanged.
- **Conflicted with zero parsed files** — `conflicted · vs develop · 4m ago`, no
  count, no disclosure. The verdict came from an exit code and a parsing surprise
  must never soften it.
- **Unknown with a null reason** — headline only, no disclosure.
- **Unparseable or empty `checkedAt`** — both the age part and `checkedTitle` are
  `''`; the row simply shows less.
- **Large file lists** — the panel lists all of them, collapsed and scroll-capped.
  `MAX_LISTED_FILES = 5` stays in `summarizeMergeCheck`, whose consumers still have
  one line to work with.

## Testing

Written first, RED before GREEN.

`src/model/mergeCheckPanel.test.ts` (new):
- headline composition for each of the three states
- each part omitted independently when its fact is absent
- `1 file` vs `4 files`
- conflicted with zero files keeps the verdict, drops the count and the disclosure
- unknown routes its reason to the body and never to the headline
- age buckets: just now / minutes / hours / days
- garbage `checkedAt` yields `''` for both stamps

`src/ui/dashboard/state.test.ts`:
- the existing merge-check assertion updated to `MergeCheckPanelRow`

`src/ui/dashboard/webview.test.ts`:
- Resolve is still offered only for `conflicted` (existing test, unchanged)
- the disclosure renders only when `detailsLabel` is non-empty
- `files` and `reason` are both escaped

## Out of scope

- `summarizeMergeCheck` wording, and therefore the ship strip and `karst context`.
- Re-checking mergeability from this row; the panel's existing refresh control
  already re-probes every PR.
- The conflict-resolution session itself (`workflow/conflictSession.ts`).
