<!-- AGENT INSTRUCTIONS:
This file uses an agent-optimized block format. DO NOT read this file entirely.
1. TABLE OF CONTENTS: grep -E '^## \[@' docs/ui/RESPONSIVE-DENSITY.md
2. EXTRACT ONE BLOCK: awk -v id="[@ui:RD-TIERS]" 'index($0,"## " id)==1{p=1} p{print} index($0,"END_DOC_BLOCK: " id)==1{exit}' docs/ui/RESPONSIVE-DENSITY.md
-->
# Responsive density spec (T764 / D240)

Status: **proposal for user review**. No product code changes with this spec. Evidence: [`responsive-audit/README.md`](responsive-audit/README.md) (screenshots + `measurements.json`). Example: [`RESPONSIVE-DENSITY-EXAMPLE.html`](RESPONSIVE-DENSITY-EXAMPLE.html). Rules: UI-R49..R56 in `UI-RULES.md` group E.

Goal: every webview usable at 320 px (floor) with 3–4 editor groups on a 14" laptop (~1212 / 600 / 400 / 300 px panes), no sideways scroll (UI-R43), no clipped required information (UI-R44), no nested scroll (UI-R45).

## [@ui:RD-CONTENTS] Contents

| Key | Topic |
|---|---|
| `ui:RD-TIERS` | Container tiers and how a region declares them |
| `ui:RD-LADDERS`, `ui:RD-LADDERS2` | Collapse ladder per shared element (2nd: tables, tabs, forms, drawers, toasts) |
| `ui:RD-NEVER` | Never-collapse list |
| `ui:RD-A11Y` | Icon-only accessibility contract |
| `ui:RD-VIEWS` | Per-view region tables |
| `ui:RD-PRIMITIVES` | Primitive API proposals (vanilla + React) |
| `ui:RD-GATE` | Gate plan and known-failures ledger |
| `ui:RD-BACKLOG` | Ordered implementation backlog |
| `ui:RD-OPEN` | Open questions for the reviewer |
END_DOC_BLOCK: [@ui:RD-CONTENTS]

## [@ui:RD-TIERS] Container tiers

| Tier | Container inline-size | Typical pane (14" MBP) | Audit anchor |
|---|---|---|---|
| `wide` | ≥ 1000 | 1 group (1212) | all views fine |
| `mid` | 700 – 999 | 2 groups, or 1 group with side bar open | dashboard header starts to crowd |
| `narrow` | 400 – 699 | 3 groups (≈ 400–600) | **first breakage at 600** (header title `A…`, session row overlap), vertical text at 400 |
| `tight` | 320 – 399 | 4 groups / side bar view; **320 is the floor** | dashboard 342–382 px natural minimum; usage/resources 338 |

**Numbers confirmed, not changed.** They match the tiers already pinned for `src/ui/layout/layoutBreakpoints.ts` (`WIDE_MIN` 1000, `NARROW_MAX` 699) and the existing in-view container queries (`#inside` 430 / 360 / 300, `.svpanel` 400) which already fall inside `narrow` / `tight`. One addition: `tight` is `max-width: 399px`, so the gate must probe **399/400** (see `ui:RD-GATE`).

Rules:

1. **Regions, not windows.** A region (`[data-region]`) declares `container-type: inline-size` and its children adapt with `@container (max-width: 999px | 699px | 399px)`. Window `@media` stays only for page chrome (settings nav). Reason (audit `ui:RA-NOTE-WINDOW`): a 2-column dashboard at 1212 gives each panel ≈ 570 px, so a panel is `narrow` inside a `wide` page.
2. **Literal px only.** Container queries cannot read custom properties, so the three boundaries (`1000`, `700`, `400`) are literals, pinned by a test like `BREAKPOINT_PINNED_FILES`. Tier names are the vocabulary; px appear in one CSS helper (`ui:RD-PRIMITIVES` k-adapt) plus any legacy block listed in the ledger.
3. **Tracks:** `minmax(0, …)` for every flexible track; no fixed-px track sum may exceed 320 − 2 × `--k-space-5`. Fixed tracks only for glyphs (≤ `--k-space-9`). Audit offenders: dashboard `:954` (202 px fixed before text), `:1013` (≥ 450 for four tracks), PresetsSection `240px 140px minmax(360px,1fr)` (740).
4. **Cascade order:** tier CSS goes **after** the base rule (audit: `.grid{1fr 1fr}` at `webview.html:1389` silently defeats the 699 px stack at `:1280`).
5. **One tier per region.** Nested regions each resolve their own tier; a child never reads its ancestor's.
6. **Heights:** tight targets stay ≥ `--k-hit-min` (24 px). Density removes labels and chrome, never hit area (`ui:RD-A11Y`).
END_DOC_BLOCK: [@ui:RD-TIERS]

## [@ui:RD-LADDERS] Collapse ladders (exact)

Every shared element renders ONE form per tier from the shared primitive; a hidden form never stays in the DOM as a duplicate span (the planning mock's mechanism is rejected). Anything dropped from the visible form is reachable via tooltip/menu (`ui:RD-A11Y`).

### Agent core identity (UI-R10c, amended)

| Tier | Renders | Example | Moved to tooltip |
|---|---|---|---|
| wide | icon + core name + model | `[◆] Claude Code · Claude Opus 4.1` (192 px) | – |
| mid | icon + core name + short model | `[◆] Claude Code · Opus 4.1` | long model id |
| narrow | icon + core name | `[◆] Claude Code` | model |
| tight | icon only (24 px hit, name `aria-label`) | `[◆]` | `Claude Code · Claude Opus 4.1` |

Mock confirmed except the mid step (mock jumped from full to icon): the audit shows the name+model pair is what overflows, so model leaves first, name second.

### Timestamp (`formatTime(ts, tier, now)`)

| Tier | Form | Exact strings |
|---|---|---|
| wide | absolute | `2026-10-23 14:05` |
| mid | absolute, year dropped | `Oct 23, 14:05` |
| narrow | relative | `now`, `5m ago`, `2h ago`, `3d ago`; ≥ 30 d → `Oct 23` |
| tight | short relative | `now`, `5m`, `2h`, `3d`; ≥ 30 d → `Oct 23` |

Always: `<time datetime="2026-10-23T14:05:09Z" title="2026-10-23 14:05:09 UTC">`. Tight buckets equal the existing `model/inside/age.ts` (`3m`, `2h`, `4d`), so the tight form needs no new rule; negative spans clamp to `now`.

### Numbers, tokens, cost

| Value | wide | mid | narrow | tight |
|---|---|---|---|---|
| tokens | `1,234,567 tok` (exact) | `1.2M tok` | `1.2M` | `1.2M` (unit glyph `Σ` from the row label) |
| cost | `$12.34` | `$12.34` | `$12.34` | `$12.3` (`$123` ≥ 100; `<$0.01` stays `<$0.01`) |
| count | `1,234` | `1,234` | `1.2k` | `1.2k` |

Abbreviation reuses `model/tokenFormat.ts` `formatTokens` (never rounds non-zero to 0). Exact value is always in `title` (`formatExactTokens`). Columns of numbers right-align and use `font-variant-numeric: tabular-nums`.

### Buttons

| Class | wide | mid | narrow | tight |
|---|---|---|---|---|
| primary (`.k-btn.primary`) | icon + label | icon + label | icon + label | **label kept**, icon dropped if label > 60 % of width; wraps to full-width row |
| secondary (`.k-btn`) | icon + label | icon + label | icon only + tooltip (while ≤ 3 in the row) | goes to ⋯ menu |
| destructive (`.k-btn.danger`) | icon + verb + noun | icon + verb + noun | icon + verb (`Delete`) | in ⋯ menu **as text** `Delete branch`; never icon-only |

### Action rows → ⋯ overflow (`k-actions`)

| Tier | Visible | Overflow |
|---|---|---|
| wide | all, labelled | none |
| mid | primary + up to 3 secondary labelled | rest |
| narrow | primary + up to 2 secondary icon-only | rest |
| tight | primary (label) + ⋯ | all secondary + destructive |

Order inside ⋯ equals DOM order; the primary is never inside ⋯ (`ui:RD-NEVER`). Keyboard: ⋯ is a `menu` button, arrow keys move, Esc closes (UI-R19).

### Stage rail (`.stepper`)

| Tier | Renders |
|---|---|
| wide / mid | glyph + full label per stage (`IMPLEMENTATION`) |
| narrow | glyph + short label (`IMPL`) for current stage, glyph only for the rest (current always labelled) |
| tight | dots only + one text line `IMPL · 3/7` under the rail |

Audit: already abbreviates to `IMPL` at 600/400; the tight text line is new.

### Status / PR / branch chips

| Chip | wide / mid | narrow | tight |
|---|---|---|---|
| status | glyph + `Running` | glyph + `Running` | glyph + text kept (status text is a never-collapse glyph, label may ellipsis at 12ch) |
| PR | `#421 · open · checks passing` | `#421 · open` | `#421` (state glyph, rest in tooltip) |
| branch | `feat/FEAT-142-s1` | middle ellipsis `feat/FE…42-s1` | `…42-s1` (last 12 chars), full in tooltip |

### Ticket id + title

`T942017 FEAT-142 Add per-repo base branch…` — id never collapses; key may drop at tight; title is the one flexible text (`min-width:0`, `overflow:hidden`, `text-overflow:ellipsis`, 2 lines allowed at narrow/tight, `line-clamp: 2`). Audit: dashboard title is 35 px (`A…`) at 600 because the header actions row takes the line first; fix = actions drop below the title at narrow.

### File paths (middle ellipsis)

| Tier | Form |
|---|---|
| wide | full repo-relative path |
| mid | full, directory prefix ellipsis if > container |
| narrow / tight | `src/ui/…/webview.html` (first segment + `…` + last two); file name never truncated; full path in tooltip + `aria-label` |

Implementation: CSS-only two-span trick is rejected; use one text node split by `pathParts()` (head, tail) rendered as `<span class="k-path"><span class="k-path-head">src/ui/dashboard/</span><span class="k-path-tail">webview.html</span></span>` with head `overflow:hidden; text-overflow:ellipsis; flex:0 1 auto; min-width:0` and tail `flex:none`. No duplicated content.

END_DOC_BLOCK: [@ui:RD-LADDERS]

## [@ui:RD-LADDERS2] Collapse ladders (exact), continued: tables, tabs, forms, drawers, toasts

### Tables → stacked cards

| Tier | Form |
|---|---|
| wide / mid | `<table>`, all columns |
| narrow | table with secondary columns dropped (priority 1–3 kept, others in row `title`/detail) |
| tight | each row a card: first cell as heading, remaining cells as `label: value` pairs, 2 columns of pairs max |

Audit: usage By-ticket table 405 px, resources table 507 px, servers table. Same markup (`<table>` with `data-priority` on `th`) in all tiers; cards are CSS `display:grid` on `tr` + `td::before{content:attr(data-label)}`, so assistive tech keeps table semantics (`role` preserved via explicit roles).

### Tabs / segmented controls

| Tier | Form |
|---|---|
| wide / mid | all tabs labelled, single row |
| narrow | labelled, horizontal scroll forbidden: overflow tabs → `More ⌄` |
| tight | active tab labelled, others icon-only; if no icon: `select` fallback (native `<select>` with same options) |

### Forms (label placement)

| Tier | Label | Control |
|---|---|---|
| wide | left column (grid `max-content 1fr`) when the form region ≥ 700 | fills |
| mid | above | fills up to `--k-content-max` |
| narrow / tight | above, never ellipsised | full width; paired numeric inputs stack when each would be < 80 px (audit: 24 px at 320); help text below |

Sticky action bar (ticketForm): at tight it becomes non-sticky or reserves its height (`padding-block-end`) so it never covers fields (audit: covered the REPO card at 320).

### Drawers / modals

| Tier | Drawer | Modal |
|---|---|---|
| wide / mid | right drawer `min(23 × space-8, 86vw)` | centred, max `--k-content-max` |
| narrow | right drawer `min(…, 92vw)` | centred, 92vw |
| tight | **full-width sheet** (100vw, close button 24 px hit) | full-width sheet, actions stacked, primary last |

A closed drawer must not extend `scrollWidth` (audit: ticket-data drawer visible right of 320). Use `visibility:hidden` + `inert` when closed.

### Toasts

wide/mid: bottom-right, max 360 px. narrow: bottom, 92vw. tight: bottom full width, single line + ellipsis, action ≤ 1, `role="status"`, no auto-dismiss when it carries an action.
END_DOC_BLOCK: [@ui:RD-LADDERS2]

## [@ui:RD-NEVER] Never-collapse list

These are never icon-only, ellipsised away, hidden, moved into ⋯, or tooltip-only at any tier (including `tight`):

1. **Primary action label** (`Create & start session`, `Merge`, `Approve`).
2. **Status glyphs** (running / passed / failed / waiting / attention) — they may lose their text, never their glyph or accessible name.
3. **Destructive action names** — in ⋯ they render as text `Delete branch`, never `🗑`.
4. **Ticket id** (`T942017`) — title may ellipsis, id may not.
5. **Form labels** — wrap or move above the control; never placeholder-only.
6. The **current** stage's text label.

Also never: horizontal scroll of the page (UI-R43), a nested scroll box to hide overflow (UI-R45), `title`-only disclosure of required information (UI-R44, DESIGN-SYSTEM §11.18).
END_DOC_BLOCK: [@ui:RD-NEVER]

## [@ui:RD-A11Y] Icon-only accessibility contract

A control that renders icon-only at any tier MUST:

1. have a computed accessible name equal to its full label (`aria-label` or visually-hidden text), identical in every tier (UI-R19);
2. show a **k-tooltip** with that label on pointer hover **and** keyboard focus (DESIGN-SYSTEM §11.18); tooltip never carries information found nowhere else;
3. keep hit area ≥ `--k-hit-min` (24 px) with ≥ 4 px between neighbours (UI-R22);
4. keep a visible focus ring (`--k-focus`);
5. expose the dropped text to non-hover users: the same string in the ⋯ menu or detail view (UI-R44);
6. never be the **only** way to reach a destructive or primary action;
7. state (selected / pressed / disabled) is conveyed by `aria-*` plus a non-color cue, as at wide.

Verification: the layout gate adds check **j. icon-only-has-name** (button/role=button with no text content must have `aria-label` or `aria-labelledby`), and the focus ratchet (`focus.visual.ts`) is untouched because focus order does not change between tiers.
END_DOC_BLOCK: [@ui:RD-A11Y]

## [@ui:RD-VIEWS] Per-view region tables

Columns: audited element → ladder → target at each tier. Grid templates use `minmax(0,…)`; `S` = `var(--k-space-N)`. Source lines are from the audit.

### Dashboard (waits for the React migration, see `ui:RD-BACKLOG`)

| Region | Element | Ladder | wide | mid | narrow | tight |
|---|---|---|---|---|---|---|
| header | title row | ticket id + title | one row | one row | title own line, actions row below | same, actions = primary + ⋯ |
| header | core identity | core | full | short model | name | icon |
| header | `.headerActions` | action row | all | 3 + ⋯ | primary + 2 icons | primary + ⋯ |
| stage rail | `.stepper` | stage rail | labels | labels | current label | dots + `IMPL · 3/7` |
| `#inside` | `.session-head` (`:1013`) | core, numbers, time | `20px minmax(78px,110px) minmax(0,1fr) auto` | same | `20px minmax(0,1fr) auto` (core name into row 2) | `20px minmax(0,1fr)` + row 2: core icon, tok, time |
| `#inside` | `.op summary` (`:783`) | time, numbers | 5 tracks | 5 tracks | `20px minmax(0,1fr) auto 16px` | `20px minmax(0,1fr) 16px`, meta as row 2 |
| `#inside` | `.timeline-row` (`:1028`) | core, time | `var(--timeline-col) minmax(110px,160px) minmax(0,1fr) auto` | same | `var(--timeline-col) minmax(0,1fr) auto`, core icon only | `minmax(0,1fr) auto`, time row 2 |
| `#inside` | `.gate-row` (`:954`) | status, time | 5 tracks | 5 tracks | `18px 70px minmax(0,1fr) auto` | `18px minmax(0,1fr) auto`, name row 2 |
| `#inside` | `.finding`, `.recovery-round`, `.evidence-row`, `.graph-node`, `.commit-*`, `.sp-row` | label+value | existing | existing | `minmax(0,1fr)` label above value (`@container` replaces 430 rules) | same |
| sub-tasks | `.subtask` | ticket id, chips | 4 col | 4 col | id + title + chip row | id + title; chip row below |
| servers | `.svpanel` table | table → cards | 6 col | 5 col | 3 col (service, status, address) | cards; actions → ⋯ |
| worktrees | `.panel` rows | paths, action row | row | row | 2 lines, actions icon-only | repo + branch chip, path middle-ellipsis, ⋯ |
| PRs | `.pr` | PR chip, buttons | 1 line | 1 line | chip + title, Merge primary | chip + title, Merge primary full width |
| layout | `.grid` | – | `1fr 1fr` | `1fr 1fr` | `minmax(0,1fr)` (**declared after** base rule) | same |
| sandbox | strip + popover | buttons | row | row | wrap | wrap; popover `max-width:min(300px,calc(100vw - 2*S5))`, end-anchored |
| drawer | `.tdDrawer` | drawers | right | right | right 92vw | sheet 100vw, `visibility:hidden` closed |

### Sidebar (reference, verify only)

Keep single-line rows (`.rowopen` flex + ellipsis). Add `data-region` landmarks. At tight: stage pill `IMPL` stays; filter chips wrap (already do).

### Settings

| Route / region | Element | Target |
|---|---|---|
| nav | section list | narrow/tight: horizontally wrapping chip row (not 7 stacked rows ≈ 190 px) |
| general | numeric pairs | pair stacks when each < 80 px; input min 6ch |
| git | `.k-field-help` variables chip | wraps, `overflow-wrap:anywhere` |
| services | repo card | `repeat(auto-fill, minmax(min(100%, 290px), 1fr))` |
| agents → roles | `--agents-cols` matrix (`agents.webview.css:73`) | region container: wide 6-col; mid 4-col; narrow/tight cards (one core per card: core icon+name heading, then labelled rows `Model`, `Effort`, `Backend`) |
| agents → profiles | master/detail (`:227`) | narrow/tight: list OR detail with Back |
| presets | `240px 140px minmax(360px,1fr)` | wide as is; mid `minmax(0,1fr) minmax(0,1fr)`; narrow/tight single column, label above |
| all | window `@media` 1024/768/699 | replaced by region container queries |

### Usage, Resources

| Element | wide / mid | narrow | tight |
|---|---|---|---|
| `.stats` cards | `repeat(auto-fit,minmax(min(100%,calc(var(--k-space-9)*5)),1fr))` | 3–4 per row | **2 per row**, value + label inline (replaces 1/row × 7 screens) |
| `.panel` / `.brow` | 2-col | 1-col | 1-col, `%` column dropped to tooltip |
| By-ticket table / attribution table | table | drop priority-3 columns | cards (`ui:RD-LADDERS` tables) |
| Resources spark `svg#spark` | fixed width | `viewBox` + `width:100%` | same, ticks thinned to 4; scale note moves under chart |

### Diffs

| Element | Target |
|---|---|
| tree rows | single-child directory chains flattened at narrow/tight (`src/ui/dashboard` one row); indent 12 px/level capped at 3 levels |
| file rows | status letter + middle-ellipsis path; rename `old → new` becomes two lines (`old`, `→ new`) |
| commit rows | id + subject; author·date to a second line at tight; counter inline |

### Ticket form

Layout B′ (prototype: `docs/design/ticket-form-b-prime.html`). Regions in DOM order: `header`, `content`, `settings`, `actions`. Tiers are measured on the shell container, `@container` 999/699/399.

| Region / element | wide ≥1000 | mid 700-999 | narrow 400-699 | tight 320-399 |
|---|---|---|---|---|
| columns | `minmax(0,1fr) 320px` | `minmax(0,1fr) 280px` | one column, settings under content | same |
| content labels | left when the content region is ≥700px, else above | above | above | above |
| settings labels | above | above | above | above |
| repo chips | wrap, base-branch ▾ action kept | same | same | same, chips wrap |
| `actions` bar | sticky | sticky | sticky | static (never covers fields); primary full width, last |
| agent picker `#agentIdentityPicker` | – | – | – | `.ap` single column; `.ap-trigger-label` 2-line allowed |
| context drawer | – | – | – | sheet |

### gettingStarted, serverLogs

No change; keep in the gate at 400 and 320.
END_DOC_BLOCK: [@ui:RD-VIEWS]

## [@ui:RD-PRIMITIVES] Primitive API proposals

All primitives get a vanilla form (class + `data-*`, CSS-only wherever possible) and a React form (thin wrapper over the same class names). Logic that decides a *string* lives in `src/model/` (pure, host-side formatting, as `tokenFormat.ts`) and is pushed to the webview; tier-dependent *layout* lives in CSS. A webview cannot import a model formatter, so the vanilla path receives pre-rendered per-tier strings in data attributes only where CSS cannot choose (time, counts).

| Primitive | Vanilla | React | Tier source |
|---|---|---|---|
| **k-adapt** (region helper) | `<section class="k-region" data-region="inside">` → CSS `.k-region{container-type:inline-size}` + `@container (max-width:999px/699px/399px)` blocks in `src/ui/shared/density.css`; optional `observeTier(el, cb)` (ResizeObserver) sets `data-tier="wide|mid|narrow|tight"` for JS-only logic | `useTier(ref): 'wide'|'mid'|'narrow'|'tight'` | container width of the nearest `.k-region` |
| **CoreIdentity** | `.k-agent-core` (exists) gains parts: `.k-agent-core__icon`, `__name`, `__model`, `__model-long`; CSS hides parts per tier; wrapper always carries `aria-label` full + `data-tip` | `<CoreIdentity core model modelShort />` | CSS container query only (no JS) |
| **formatTime(ts, tier, now)** | model emits `{abs, absShort, rel, relShort, iso, title}`; markup `<time class="k-time" datetime title data-abs data-rel>`; CSS `content: attr(data-rel)` swaps at tier (the one allowed use of generated content; text duplicated in attributes, not in DOM spans) | `<Time ts now />` picks string by `useTier` | container tier |
| **formatCount / formatTokens** | `formatTokens` exists; add `formatCost(n, tier)`; markup `<span class="k-num" data-exact title>` | `<Num value kind="tokens|cost|count" />` | tier |
| **k-actions** (overflow row) | `<div class="k-actions" data-primary="…">` children `.k-act[data-priority=1..n]`; JS `initActions(el)` (ResizeObserver, moves overflowing `.k-act` into `<k-menu>` popover, restores on grow); no-JS fallback = wrap | `<Actions items primaryId />` render-prop; uses `useTier` + measured widths | measured available width (tier is a hint only: priority decides who leaves) |
| **k-tooltip** | `data-tip="Full label"` + one delegated listener on `document` (hover + focusin), single `role="tooltip"` node, `aria-describedby` wired on show, Esc dismisses (SG-19) | `<Tip label>` wrapper | n/a |
| **k-path** | `.k-path` head/tail spans (above), `pathParts(path)` in model | `<Path value />` | CSS |
| **k-table-cards** | `<table class="k-table" data-cards="tight">`, `td[data-label]` | `<Table columns rows />` | tier |

**Migrate to React first: `k-actions` + `k-tooltip`.** They are the only primitives with real state (measurement, open menu, focus management, delegated listener lifecycle), the Settings reference pattern already hosts such components (`renderWebviewReady`), and the dashboard's React migration (`SandboxStrip`, phase-1 pipeline) needs them. CoreIdentity, time, count, path, table-cards stay CSS + model strings (React wrappers optional).

Constraints: no new runtime deps; `vscode`-free; every tier change testable in jsdom via `data-tier` plus visually through the layout gate; no `spawnSync`.
END_DOC_BLOCK: [@ui:RD-PRIMITIVES]

## [@ui:RD-GATE] Gate plan and known-failures ledger

1. `LAYOUT_WIDTHS` (`src/ui/layout/layoutBreakpoints.ts:16`): `[1280, 900, 700, 699, 480]` → `[1280, 900, 700, 699, 480, 400, 399, 320]`. Boundary pair 400/399 opens the `tight` edge exactly as 700/699 opens `narrow`; 320 is the floor. `tierFor()` gains `tight` (`< 400`) and the `layoutBreakpoints.test.ts` ratchet "opens both sides of each boundary" is extended.
2. Add layout check **j. icon-only-has-name** (`ui:RD-A11Y`) and **k. min-hit-area** (≥ 24 px at all widths) beside the existing checks a–i.
3. The ledger `tests/visual/layout-known-failures.json` (149 entries today) is **never edited to pass**. New widths produce new failures; they are recorded once, by the gate-widening ticket, in a **separate per-view file** `tests/visual/layout-known-failures.<view>.json` (so each implementation ticket owns, and deletes, only its own view's lines). A ticket's definition of done = its view's file is empty.
4. The audit script `responsive-audit/capture.ts` stays as evidence tooling; it is not a gate.
5. Docker visual run (`test:visual:docker`) is required after each view change (CLAUDE.md); baselines at the new widths are recorded by the owning view ticket.
6. The `BREAKPOINT_PINNED_FILES` list grows by one file per migrated view; any `@container`/`@media` px outside `{400, 700, 1000}` ±1 fails that test.
END_DOC_BLOCK: [@ui:RD-GATE]

## [@ui:RD-BACKLOG] Ordered implementation backlog

One ticket each. `←` = depends on.

| # | Ticket | Scope | Depends on |
|---|---|---|---|
| B0 | Gate widening | `LAYOUT_WIDTHS` + `tierFor('tight')` + checks j/k + per-view ledgers split (no product change) | – |
| B1 | `density.css` + `k-region` + tier pin test | tokens-only CSS, `observeTier`, `useTier` | B0 |
| B2 | `k-tooltip` (vanilla delegate + React `Tip`) | SG-19, UI-R19 | B1 |
| B3 | `k-actions` overflow + `k-menu` (React first, vanilla twin) | `ui:RD-LADDERS` buttons/rows | B1, B2 |
| B4 | CoreIdentity parts + UI-R10c amend in CSS | `.k-agent-core` | B1, B2 |
| B5 | Time/count formatting: `formatTime`, `formatCost`, `pathParts` in `src/model/` | pure, mutation-gated | – |
| B6 | Usage view | stats 2-up, panels, table → cards | B1, B5 |
| B7 | Resources view | spark `viewBox`, table → cards | B6 |
| B8 | Diffs view | tree flatten, paths | B1, B5 |
| B9 | Ticket form | sticky bar, picker, drawer sheet | B1, B3, B4 |
| B10 | Settings: nav, general, git, services | container conversion | B1 |
| B11 | Settings: presets + agents matrix → cards | | B10, B4 |
| B12 | Sidebar landmarks + tight verification | | B1 |
| B-SANDBOX | Sandbox popover width/anchor | `SandboxStrip.css` | B1 (React already) |
| **D1..D6 (wait for `dashboard-sandbox-as-a-full-fu1-s1-migrate-dashboard-webview`, d83f4330818)** | | | |
| D1 | Dashboard landmarks + `.grid` cascade fix + drawer `inert` | `webview.html` / React | migration, B1 |
| D2 | Header, title, stage rail, core identity | | D1, B3, B4, B5 |
| D3 | `#inside` session / op / timeline / gate rows (replace 430/400/360/300 blocks) | | D1, B5 |
| D4 | Sub-tasks, findings, recovery, evidence rows | | D3 |
| D5 | Servers table → cards, worktrees, PR panel | | D1, B3 |
| D6 | Remove dashboard ledger lines, record baselines | | D2–D5 |

Out of scope: click-feedback (D239), any behaviour change.
END_DOC_BLOCK: [@ui:RD-BACKLOG]

## [@ui:RD-OPEN] Open questions for the reviewer

1. **`mid` step for core identity** (short model) is a correction of the mock's two-step ladder. Keep?
2. **Tight stage rail** text line `IMPL · 3/7`: acceptable vs. dots-only?
3. **Settings agents matrix → cards** at narrow instead of the current 4-track stack: agree?
4. **Per-view known-failure files** (split from the single ledger): agree, since it changes how the existing ledger is consumed (no baseline edits)?
5. React-first components: `k-actions` + `k-tooltip` (recommended).
END_DOC_BLOCK: [@ui:RD-OPEN]
