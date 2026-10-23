<!-- AGENT INSTRUCTIONS:
This file uses an agent-optimized block format. DO NOT read this file entirely.
1. TABLE OF CONTENTS: grep -F "## [@" docs/ui/responsive-audit/README.md
2. EXTRACT ONE BLOCK: awk '/^## \[@ui:RA-DASH\]/,/END_DOC_BLOCK: \[@ui:RA-DASH\]/' docs/ui/responsive-audit/README.md
-->
# Responsive-density audit (T764)

Measured evidence for [`../RESPONSIVE-DENSITY.md`](../RESPONSIVE-DENSITY.md). Evidence only: no product code changed.

## [@ui:RA-METHOD] Method

- Fixture pages from `tests/visual/serve.mjs` (the layout-gate / visual-sweep pages, real injector chain, `realistic` settings corpus), rendered by `capture.ts` in this folder with the repo's Playwright Chromium, height 900, DPR 1, UTC.
- Widths **1212 / 600 / 400 / 320** (14" MBP with 1–4 editor groups). A fifth **200 px probe** (not screenshotted) reads the page's natural `scrollWidth`: the minimum width the layout can reach before the page scrolls sideways.
- Dark theme for every target; **light** variants for `dashboard-running` and `sidebar` (`*-light/`). Geometry is theme-independent; light is there to eyeball contrast.
- Screenshots: `<target>/<width>.png` (full page). Raw numbers: `measurements.json` (per width: page `scrollWidth`, every element that overflows the viewport or clips its content, with selector / `data-region` / box).
- Re-run: `node tests/visual/serve.mjs &` then `npx tsx docs/ui/responsive-audit/capture.ts [name-substring]`.
- Dashboard targets are the six scenario fixtures (`pending running passed failed waiting exhausted`). `running` is the reference "ticket view".
- Caveats: (1) the dashboard has **no `data-region` landmarks** except `sandbox`/`ship-preview`; the "region" column below names the panel (`#inside`, `.svpanel`, …) instead — adding landmarks is backlog item B1. (2) Off-canvas drawers (`.tdDrawer*`, `#drawerBody`) report as `overflow-viewport`: they are translated off-screen by design, not defects. (3) `.sr`/`.sr-only` clips are visually-hidden text, not defects. (4) Fixture PR/URL strings (`fixture:https://…`) are longer than real ones only slightly; paths and titles are the same lengths as production.
END_DOC_BLOCK: [@ui:RA-METHOD]

## [@ui:RA-SUMMARY] Summary: page-level sideways scroll and natural minimum

`sw` = document `scrollWidth` at that viewport; **✗** = wider than the viewport (UI-R43 violation).

| Target | 1212 | 600 | 400 | 320 | natural min (200 px probe) | First visible breakage |
|---|---|---|---|---|---|---|
| dashboard-running | ok | ok | ok | **✗ 382** | **382** | **600** (title `A…`, core chip overlaps token chip) |
| dashboard-pending / passed / failed / waiting / exhausted | ok | ok | ok | **✗ 342** | **342** | **400** (session row vertical text) |
| sidebar | ok | ok | ok | ok | 200 | none (reference behaviour) |
| usage | ok | ok | ok | **✗ 338** | **338** | 400 (ticket table clips), 320 sideways |
| resources | ok | ok | ok | **✗ 338** | **338** | 400 (table 507 px inside 400) |
| diffs | ok | ok | ok | ok | 244 | 320 (tree indent consumes the width, commit rows wrap) |
| ticketForm | ok | ok | ok | ok | 316 | 320 (sticky action bar covers form), 400 (agent picker clips) |
| gettingStarted | ok | ok | ok | ok | 200 | none |
| serverLogs | ok | ok | ok | ok | 200 | none (log lines wrap) |
| settings-general / git / approaches / ticketing / quality / agents-profiles* | ok | ok | ok | ok | 200 | 320 (git: help chip clips, general: numeric inputs 24 px wide) |
| settings-services | ok | ok | ok | ok | 200 | 400 (repo card title / path ellipsis) |
| settings-agents-roles* | ok | ok | ok | ok | 200 | 320 (sandbox backend block unstructured; picker label ellipsis) |

Findings that change the starting hypotheses (the planning mock assumed breakage below 400):

1. **The dashboard header and session row already break at 600**, not 400. At 1212 the header row (`.headerActions`) is `Claude Code · Agent default · none ⌄ ⋯`; at 600 it takes the whole row and the title ellipsises to `A…` (35 px wide).
2. **The vertical-text failure at 400 is one row**: `#inside .session-head` (`webview.html:1013`) when the 3rd track `minmax(0,1fr)` is the only one allowed to shrink and the 4th `auto` track (`AI` chip + core + tokens + `Show all`) cannot. The 1fr track gets ~0 px and the `session k-9f2e — claude-opus-4-1` text stacks one character per line. The existing `@container (max-width:430px)` rule (`:1288`) drops it to 3 tracks but does not fix this row.
3. **A container query system already exists** (`#inside` `container-type:inline-size` at `webview.html:662`; `.svpanel` at `:1587`; breakpoints 430 / 400 / 360 / 300). The spec adopts and generalises it; it does not start from zero. 430 and 400 sit inside the proposed `narrow` tier and 360 / 300 inside `tight`; they migrate to the tier names.
4. **Sidebar proves the pattern**: it never exceeds the viewport down to 200 px because every row is `flex` + `min-width:0` + ellipsis with fixed-width icons. Tickets rows are the model for "single line, ellipsis, id never collapses".
5. **Usage/resources fail only at 320** (338 px), through `.panel` + `.stats` `repeat(auto-fit,minmax(calc(var(--k-space-9) * 5),1fr))` rounding plus a fixed-width table (`table` 405 px at 400, 507 px for resources) clipped by `overflow-x`.
6. **Settings is the healthiest page**: no sideways scroll at any width; failures are clipped controls (`input.k-input` 24 px wide at 320) and long ellipsised names.
7. **Agent-core identity (UI-R10c)** is the dominant width consumer on the dashboard: `Claude Code · Claude Opus 4.1` is 192 px (`span.agent-id`/`span.agent-core`) and appears in the header, session row, timeline and PR rows.
END_DOC_BLOCK: [@ui:RA-SUMMARY]

## [@ui:RA-DASH] Dashboard (`src/ui/dashboard/webview.html`, 6872 lines, 13 grids, 108 `white-space:nowrap`)

Reference: `dashboard-running/`. Natural minimum 382 (running) / 342 (others). Screenshots: `dashboard-<scenario>/<width>.png`.

| Region | Element | Source | 1212 | 600 | 400 | 320 | measured min |
|---|---|---|---|---|---|---|---|
| header | ticket id + key + title (`h1#title.ticketTitle`) | webview.html (header block, ellipsis) | ok, 467 px natural | **clip**: ellipsis at 35 px (`A…`) | clip 161 px | clip 81 px | needs ≥ 200 for title |
| header | `.headerActions` (core + `Agent default` + status dot + ⌄ + ⋯) | webview.html header block | one line | one line, crowds title | wraps to 2nd line, ok | **overflow** `w316 r342` (`menuWrap` past viewport) | 316 |
| header | `span.agent-id`/`.agent-core` | `.k-agent-core` | 192 px | 192 | 192 | **overflow r387** | 192 (icon+name+model) |
| stage rail | `.stepper` pills | webview.html (stepper) | all 7 labelled | `IMPLEMENTATION` + dots | `IMPL` + dots, ok | `IMPL` + dots, ok | ~290 |
| #inside | `.inside-head` (`:672`) | `grid auto minmax(0,1fr) auto` | ok | ok | `started … attempt 1` text clips past panel (`@container 430` line 1290 moves meta to col 2) | clips | 300 |
| #inside | `.session-head` (`:1013`) `20px minmax(78px,110px) minmax(0,1fr) auto` | webview.html:1013 | ok | **overlap**: model text under `Σ tok` chip | **unreadable**: 1fr track ≈ 0, title wraps per character (≈ 1400 px tall) | same, + chip overlaps | **≥ 20+78+120+auto(≈230) ≈ 450** |
| #inside | `.op summary` (`:783`) `20px minmax(78px,110px) minmax(0,1fr) auto 16px` | webview.html:783 | ok | ok | `@container 430` trims to 68–86 px, still ellipsis | clip | ≈ 200 + auto |
| #inside | `.timeline-row` (`:1028`) `var(--timeline-col) minmax(110px,160px) minmax(0,1fr) auto` | webview.html:1028 | ok | ok | `core · model` truncates `Claude Code · Claude (` | `Codex · Coc` clip | ≈ 330 |
| #inside | `.gate-row` (`:954`) `18px minmax(74px,90px) minmax(110px,150px) minmax(0,1fr) auto` | webview.html:954 | ok | ok | `@container 430` → `18px 70px 1fr auto` ok | ok | 18+74+110 = **202 fixed before text** |
| #inside | `.evidence-row` (`:860`), `.graph-node` (`:924`), `.recovery-round` (`:1084`), `.done-line` (`:1103`), `.commit-*` (`:1166,1184`), `.sp-row` (`:1255`) | webview.html | ok | ok | rely on 430 container remap | ok | each ≥ 170 fixed |
| sub-tasks | `.subtask` rows (`span.subtask-title`) | webview.html | full title | full | ellipsis at 121 px; `BLOCKING` chip + `impl` crowd id | title 41 px (`Extra…`), `impl` clipped | ≈ 360 for 4 columns |
| servers | `.svpanel` table (`:1587` container) | `@container 400` `:1675` | 6 cols | 5 cols (address shortened) | `SERVICE ADDRESS` only, actions **clip** (`sw 236 > 164`) | 124 px wide, clip | 236 |
| worktrees | `.panel` (web/api rows, branch pill, path, 3 icon buttons) | webview.html | 1 line each | 1 line | 2 lines, `.wacts` icons overflow (r454 > 400) | 2 lines, path ellipsis `feat/FEAT…` | 245 |
| pull requests | `.pr` row: status chip + repo + URL + `#421` + Merge | webview.html | 1 line | 1 line | wraps, URL ellipsis 174 px | URL 135 px, `pbranch` ellipsis 111 px | ok but URL meaningless |
| layout | `.grid` 2-col (`:1389`) | `@media (max-width:699px)` `:1280` intended 1 col but **overridden by `:1389`**; `@media (max-width:380px)` `:1438` | 2 col | **2 col** (stack rule dead) | 2 col pair squashed (166 + 143 px) | 2 col pair squashed (126 + 117 px) | — |
| (drawer) | `.tdDrawer*` ticket-data drawer (`:2004`, `translateX(100%)`, `width:min(23*space-8,86vw)`) | webview.html | off-canvas | off-canvas | off-canvas | off-canvas, but its box extends the page scrollable area in the 320 screenshot (visible to the right of the 320 px content) | 274 |
| sandbox strip | `.sandbox-strip` (`app/SandboxStrip.css:1`, React) flex + `flex-wrap` main, actions right | SandboxStrip.css | ok | ok, wraps | ok, wraps | ok (floor set by header, 382) | ≤ 320 |
| sandbox strip | `.sandbox-popover` (300 px, absolute, opened state) | SandboxStrip.css | ok | **overflow-viewport**: page `sw` 704 at 600, 477 at 400 (popover + domain tags past the right edge) | same | same | 300 + anchor offset |

Sandbox verdict (`dashboard-sandbox/`, `dashboard-sandbox-host-note/`): the strip itself is compliant (React, wrap + `min-width:0`); its **popover** is not: fixed 300 px, anchored to the trigger, escapes the viewport when the trigger sits right of centre. Needs `max-width:min(300px,calc(100vw - 2*space))` and end-anchored placement (backlog B-SANDBOX).

**Cascade bug (confirmed from source + screenshots):** `@media (max-width:699px){.grid{grid-template-columns:1fr}}` is at `webview.html:1280-1281`, but the base rule `.grid{grid-template-columns:1fr 1fr}` is declared later at `:1389` with equal specificity, so the later rule wins and **the 699 px stack never applies**. That is why Servers / Worktrees stay side by side at 600 and 400 (`dashboard-running/600.png`, `400.png`). Any new tier CSS must be declared after the base rule or use `@container`, which the spec requires anyway.

Other scenarios: `failed` adds the red gate banner + findings (`.finding` `56px minmax(0,1fr)`), `waiting` adds the approval card, `exhausted` the retry/recovery ladder (`.recovery-round` `18px 56px minmax(0,1fr) auto`); all share the 342 px floor (finding/recovery rows fixed tracks).
END_DOC_BLOCK: [@ui:RA-DASH]

## [@ui:RA-SIDEBAR] Sidebar (`src/ui/sidebar/webview.html`)

| Region | Element | Source | 1212 | 600 | 400 | 320 | min |
|---|---|---|---|---|---|---|---|
| search | search box + filter chips (`.k-chip`) | webview.html | 1 row | 1 row | wraps to 2 rows | 2 rows, no clip | ≤ 200 |
| list | ticket rows: status glyph, `T900001`, key (bold), stage pill `IMPL` | `.rowopen` `:141` flex, `.pt-label` `:393` ellipsis | ok | ok | ok | ok; `FEAT-100-s1-s1` stays whole, stage pill right-aligned | ≤ 200 (4 offenders at 200: pill clip only) |
| list | plan rows, sub-ticket tree indent | `.pt-deps-row` `:399` wrap | ok | ok | ok | ok | — |

Verdict: **reference implementation** for single-line rows. No work except the 200 px pill clip (out of scope, floor is 320).
END_DOC_BLOCK: [@ui:RA-SIDEBAR]

## [@ui:RA-USAGE] Usage (`src/ui/usage/webview.html`)

| Region | Element | Source | 1212 | 600 | 400 | 320 | min |
|---|---|---|---|---|---|---|---|
| header | title + range chips (`Last 24 hours`…) + `Spend`/`Quota` tabs | webview.html | 1 row | 1 row | wraps | wraps, chips 2-line text | — |
| stats | `.stats` `repeat(auto-fit,minmax(calc(var(--k-space-9)*5),1fr))` | `:40` | 7 cards 1 row | 3–4/row | 2/row | **1/row, each card ~85 px tall, 7 screens of cards** | density bug, no overflow |
| panels | `.panel` By stage / model / profile; `.brow` (label, value, %) | `:53,69` | 2-col | 1-col | ok | **overflow +18 px** (panel 312 vs 302 body) → page `sw 338` | 338 |
| table | By ticket (`table`, 6 numeric columns) | webview.html table | ok | ok | **table 405 px in 400**: `Last call` header and column clip | headers `Calls Input Output T…` clipped, ticket `FEAT…` | 405 |
| quota | `.qwin .qlbl` `:119` | ellipsis | ok | ok | ok | ok | — |

Region ids absent (no `data-region`). Target: stat cards → one compact 2-col strip at tight; table → stacked cards.
END_DOC_BLOCK: [@ui:RA-USAGE]

## [@ui:RA-RESOURCES] Resources (`src/ui/resources/webview.html`)

| Region | Element | Source | 1212 | 600 | 400 | 320 | min |
|---|---|---|---|---|---|---|---|
| stats | `.stats` auto-fit | `:43` | ok | ok | ok | 1/row | — |
| trend | `.chartWrap` + `svg#spark` (fixed 714 px) + `#chartTicks` | `:56` | 549 box / 792 scroll | clip (inner scroll) | **clip**: chart 322 wide shows 792 content (inner scroller; UI-R45 nested scroll) | **overflow**: svg 714 > 286, scale note 175 px, `150 / 150 samples` 113 px | 792 |
| table | attribution table (Ticket, Repo/label, PID, CPU, RSS, Proc…) | `.utable` `:140` `td.cmd{max-width:0}` | ok | ok | **table 507 px in 400** | table overflows | 507 |
| rows | `.drow` `minmax(0,1fr) var(--k-space-8)` `:160`, `.drow .path` ellipsis `:162` | | ok | ok | ok (path ellipsis tail) | ok | — |

Natural min 338 (page) and 792 for the chart. Target: chart `viewBox` + `width:100%`, table → stacked cards.
END_DOC_BLOCK: [@ui:RA-RESOURCES]

## [@ui:RA-DIFFS] Diffs (`src/ui/diffs/webview.html`)

| Region | Element | Source | 1212 | 600 | 400 | 320 | min |
|---|---|---|---|---|---|---|---|
| toolbar | `Tree`/`List` segmented + `Refresh` + filter | webview.html | 1 row | 1 row | 1 row | 1 row, `Refresh` full label | ok |
| repo head | `.repo > summary` (`:161` `auto minmax(0,1fr) auto auto`, `@media (max-width:440px)` `:333` → `1fr`) | | ok | ok | stacked | stacked | ok |
| tree | nested dir rows (`src › ui › dashboard`, one indent per level, count right) | `:216` | ok | ok | indent ≈ 18 px/level × 4 = 72 px | **indent + path = 125 px for the file name; `M src/ui/dashboard/webview.html` 238 px**, file rows clip inside their box (`R src/cli/name.ts → src/cli/old-name.ts` wraps to 2 lines) | 244 (page) |
| commits | `fixture0 Fixture commit 0` + `2⌄` counter, author · date wraps | | ok | ok | ok | counter sits alone on its own line (`2⌄`) | — |

Verdict: no sideways scroll; density problem is indent depth. Target: flatten single-child chains (`src/ui/dashboard` as one row) at narrow/tight, file path middle-ellipsis.
END_DOC_BLOCK: [@ui:RA-DIFFS]

## [@ui:RA-TICKETFORM] Ticket form (`src/ui/ticketForm/webview.html`)

| Region | Element | Source | 1212 | 600 | 400 | 320 | min |
|---|---|---|---|---|---|---|---|
| form | TICKET card: Title, Key, Type, Prompt, Auto-improve switch, `Improve with AI`, Attach | `.keytype .keyfield` `:79` flex-basis `calc(var(--k-space-8)*14)` | label above control | same | same | same; `Type` select shows `Inherit (settings: feat)` in a 160 px control (control does not fill) | ok |
| footer | sticky action bar (`Cancel`, `Save draft`, `Create & start session`) | webview.html (sticky) | one row | one row | wraps | **sticky bar covers ~240 px of the form (REPO card hidden behind it)** (UI-R38/R45) | — |
| agent | `#agentIdentityPicker .ap` `:169` `repeat(auto-fit,minmax(min(100%,calc(var(--k-space-8)*5)),1fr))` | | 2 col | 2 col | 2 col; `.ap-trigger-label` ellipsis `Inherit (settings default)` 116/137 px | `Claude Co…` 76/91 px; model `Inherit (settin…` | 316 (page) |
| drawer | context brief drawer `#drawerBody` | `.drawer-head h3` `:457` | 459 px, off-canvas | 459 | 343 | 274 | — |

Min 316 (page natural). Hazards: sticky footer height and agent-core identity clip.
END_DOC_BLOCK: [@ui:RA-TICKETFORM]

## [@ui:RA-GS] gettingStarted and serverLogs

| View | Source | 1212 / 600 / 400 / 320 | min |
|---|---|---|---|
| gettingStarted | `58ch` measure, `margin-inline:auto` (UI-R48) | holds, steps stack, no clip | ≤ 200 |
| serverLogs | monospaced log lines, `overflow-wrap:anywhere` | holds, long lines wrap | ≤ 200 |

Both are compliant; nothing to implement beyond keeping them in the gate at 400/320.
END_DOC_BLOCK: [@ui:RA-GS]

## [@ui:RA-SETTINGS] Settings (every route; `src/ui/settings/**`)

CSS: `app.webview.css`, `agents.webview.css`, `app/sections/PresetsSection.css`. Breakpoints in play: 1024 / 768 (app.css `:397,:414,:502`), 999 / 699 (agents.css `:281,:307`).

| Route | Element | Source | 1212 | 600 | 400 | 320 | min |
|---|---|---|---|---|---|---|---|
| all | Section nav (`Settings sections`) | `app.webview.css` (768 media) | left rail | top list | top list, **7 stacked rows ≈ 190 px above content** | same | — |
| all | header `Settings › Agents`, `Discard`, `Save Agents` | | 1 row | 1 row | 1 row | 1 row, `Save Agents` wraps to 2 lines | — |
| general | numeric inputs pairs (`input#_r_1_.k-input`, `-second`) | `.k-input` in grid | 120 px | 120 | **64 px** | **24 px wide (content 55 px clipped)** | 120 for a 3-digit value |
| git | `.k-field-help` + `{description}` token buttons | | ok | ok | ok | **overflow** help chip `Variables: {title}{key}{id}{re…` (87 px, scroll 87) | — |
| repositories (services) | repo card (`.card-title`, `.cell-path`) | `app.webview.css:13` `repeat(auto-fill,minmax(290px,1fr))` | 3–4 cards/row | 2 | **card title ellipsis 124/324**, path `../web-fron…` 43/99 | title 96/324 | 290 card min |
| approaches | list | | ok | ok | ok | ok | — |
| agents → roles | `--agents-cols` `agents.webview.css:73` = `var(--k-space-9) minmax(140px,1fr) minmax(150px,1fr) minmax(360px,3fr) minmax(92px,1fr) calc(2*var(--k-hit-min) + var(--k-space-2))` | `:73-86` | 6 col matrix (**sums to ≈ 820 px minimum; needs ≥ 1000 container**) | 1000 media (`:281`) → 4 col | 699 media (`:307`) → 4-track stack | stack; **sandbox backend block unstructured** (`claude / host sbx` label-over-chips, 5 core rows, no heading alignment); `.ap-trigger-label` ellipsis `opencode-go/very-long-vendor-m…` 251/525 px | — |
| agents → roles compare | compare columns | `:102` `var(--k-space-9) minmax(120px,1.1fr) … calc(5*var(--k-hit-min))` | 5 col | stack | stack | stack | — |
| agents → profiles | master/detail `260px minmax(0,1fr)` `:227`; `@media 699` → 1 col with Back | | master + detail | stacked | stacked | stacked, no clip | — |
| presets (PresetsSection) | `240px 140px minmax(360px,1fr)` `PresetsSection.css:152,231` (sum **740 px fixed**) | | row | 768-media collapses to `1fr` | ok | ok | 740 (without the media rule) |

Settings is therefore OK at the page level, but depends on **window** `@media` (1024/768/699) rather than container queries: a settings page in a 400 px editor group of a 1920 px window gets the **wide** layout (matrix 820 px) because `@media` sees the window, not the pane. This is the exact failure the brief rejects (window-@media only); the audit harness viewports are equal to the pane only because Playwright resizes the page.
END_DOC_BLOCK: [@ui:RA-SETTINGS]

## [@ui:RA-NOTE-WINDOW] Why viewport sweeps under-report

A VS Code webview's `window.innerWidth` is the **editor group width**, so a sidebar-docked or split webview already reports 400 px to `@media`. The window-level bug is different: the dashboard's `@media (max-width:699px)` rules and settings' 1024/768 rules are correct inside one pane, but components (the `#inside` timeline, the servers table) that live in a *sub-region* of a wide pane (for example a 2-column dashboard at 1212 gives each panel ≈ 570 px) need container queries. Evidence: servers table in the 2-col pair at 600 (`dashboard-running/600.png`) is already 5 columns wide in a 290 px panel. Both mechanisms are specified in `RESPONSIVE-DENSITY.md` (`@ui:RD-TIERS`).
END_DOC_BLOCK: [@ui:RA-NOTE-WINDOW]
