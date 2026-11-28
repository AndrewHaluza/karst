/**
 * Sweep budget ratchet (@ui:SWEEP-BUDGET): the number of screenshots and layout tests each view adds to the visual
 * UAT gate. The sweep has one slot and one 45 min limit, and every later ticket pays for each test a change adds, so a
 * change that grows a view must say why here. `sweepBudget.test.ts` fails when a count moves: above the budget, raise
 * the number and add the reason in a comment beside it; below the budget, lower the number (shrink is free).
 *
 * Counts come from the registry alone (no Playwright run), the same way the specs build their tests:
 * - screenshots: one per variant x declared theme project (`pages.visual.ts`; a test in another project is a skip);
 * - layout: one per layout target x width (`layout.layout.ts`, shared pages counted once, see `layoutPlan()`),
 *   plus the settings routes x SETTINGS_LAYOUT_WIDTHS and one resize test per Agents route.
 */
import { SETTINGS_LAYOUT_WIDTHS, layoutWidthsFor } from '../../src/ui/layout/layoutBreakpoints.js';
import { WEBVIEW_NAMES } from '../../src/model/webviewChains.js';
import { settingsRoutes } from './settingsRoutes.js';
import { extraLayoutTargets, VARIANTS, type ViewId } from './variants.js';

export interface SweepCount {
  readonly screenshots: number;
  readonly layout: number;
}

/**
 * The budget. Raise a number only with a reason in a comment on that line (ticket id + why the new state needs its
 * own shot or layout run). First recorded after the layout runs were made one per distinct page.
 */
export const SWEEP_BUDGET: Readonly<Record<ViewId, SweepCount>> = {
  // T1099 stage-chip tier variants, @ui:UI-R57: 2 widths x 2 themes (+4 screenshots) and their layout runs (+5).
  // T1183 layout-centered / layout-full menu-open variants, @ui:UI-R57: 2 variants x 1 theme (dark) (+2 screenshots); skipLayout, so no layout runs.
  // T1190 pr-disabled-merge-hover, @ui:UI-R57: 3 width tiers x 1 theme (dark) (+3 screenshots); skipLayout, so no layout runs.
  // T1193 auto-ci-uat / auto-ci-review / auto-ci-review-confirm, @ui:UI-R57: 3 new Auto-fix step states x 4 width tiers x 1 theme (dark) (+12 screenshots) and their layout runs (+24).
  // T1217 pr-stale-checks, @ui:UI-R57: the stale CI chip, 3 width tiers x 1 theme (dark) (+3 screenshots); layout runs unchanged.
  // T1266 graph-header (a graph ticket's expert / worker / fast chips), @ui:UI-R57: 2 themes (+2 screenshots); skipLayout, so no layout runs.
  // T1289 inside-uat-gates-skip-reasons (a no-UI-change visual gate and a ticket-disabled gate), @ui:UI-R57: 4 width tiers (+4 screenshots) and their layout runs (+8).
  // T1293 inside-uat-gates-wait-and-run (one gate waits for a slot, one runs in the other lane), @ui:UI-R57: 4 width tiers (+4 screenshots) and their layout runs (+8).
  // T1319 fix-parked-gate / fix-parked-tester / fix-parked-review (a parked fix round with Retry gate and Accept and continue), @ui:UI-R57: 3 states x 4 width tiers (+12 screenshots) and their layout runs (+24).
  // T1321 DB-5 inside-review-unreadable and DB-1 inside-ship-autofix-header, @ui:UI-R57: 2 Inside cases x 4 width tiers x 1 theme (dark) (+8 screenshots) and their layout runs (+16).
  // T1340 baseline-overlay-mixed (pending, rejected and approved rows, with the Send button in the header), @ui:UI-R57:
  // 1 theme (+1 screenshot) and its layout run (+5); the existing banner-rejected shot now shows the banner's Send button.
  // T1341 baseline-overlay-prior-rejected (a pending row that shows the reason from the earlier round), @ui:UI-R57:
  // 1 theme (+1 screenshot) and its layout run (+5).
  // T1346 empty panels (Q3, @ui:UI-R57): the five missing panel states (srv-not-runnable, srv-one, wt-one,
  // subtask-empty, subtask-one) x 3 width tiers (+15 screenshots); `empty-panels` and its tight 360 shot (+2),
  // and the one new all-empty page x 5 layout widths (+5) that `empty-panels-tight` shares.
  // T1352 (@ui:VISUAL-VARIANTS, @ui:SWEEP-BUDGET): the width-tier prune removes 321 redundant full-page shots across
  //   the five dashboard families — inside-* 240 (186 dark + 27 light + 27 hc: tiers are now dark-only and only the 16
  //   representative cases carry them), panel-* 46, runtime-* 14, ticket-details-* 12, drill-* 9. Every state keeps its
  //   default/wide shot and `layout.layout.ts` still opens every page at every width, so `layout` is unchanged (785).
  // T1343 Q1 inside-ship-merge-blocked (the banner owns the one Resolve) and DB-9 inside-review-unreadable-blocked (the
  // short label beside the banner), @ui:UI-R57: 2 Inside cases x 1 theme (dark), default shot only after the T1352 prune
  // (+2 screenshots), and their layout runs (+16).
  // T1357 panel-wt-normal removed: it recorded the same picture as panel-srv-running, @ui:VISUAL-VARIANTS (-1 screenshot).
  // T1357 subtask-blocked removed: it recorded the same picture as populated (dashboard-running) in dark and light, @ui:VISUAL-VARIANTS (-2 screenshots; it had no layout run).
  // T1359 (D793) graph-blocked-config / graph-blocked-explicit / graph-blocked-replans-exhausted (the blocked banner's
  // primary Replan, its "replans used n of m" line, and the no-budget case), @ui:UI-R57: 3 states x 1 theme (dark)
  // (+3 screenshots) and, because a graph block needs the layout gate to prove the banner row wraps at every width,
  // 3 new pages x the 5 dashboard widths (+15 layout runs).
  // T1361 (@ui:VISUAL-VARIANTS): the Dynamic Graph states. Screenshots (+6): inside-impl-graph-running at dark/light/hc
  //   (+3), inside-impl-graph-dag and its explicit narrow (500 px) shot at dark (+2), inside-impl-graph-failed dark (+1).
  //   Layout (+24): 3 distinct pages x 8 widths; the narrow DAG shot shares inside-impl-graph-dag's run.
  // T1393 (@ui:UI-R57, @ui:VISUAL-VARIANTS): the capped Inside gate list. 3 new UAT states (11 gates collapsed, the same
  //   11 expanded, 9 gates with no toggle) x 1 theme (dark) (+3 screenshots) and 3 distinct pages x 8 widths (+24 layout runs).
  // T1397 (@ui:UI-R57): the ticket ⋯ menu's gate switches in two stage tabs. 3 open-menu states (both stages, both with
  //   off gates on Review, single UAT stage) x 1 theme (dark) (+3 screenshots); skipLayout, because the ticket-menu
  //   route already runs the page.
  // T1396 (@ui:UI-R57): the ticket header at wide/mid/narrow/tight in four states — a graph ticket with a planner HIGH
  //   and a long key, a provider label that names no level (P2), a closed ticket, and the scrolled sticky row.
  //   4 x 4 tiers x 1 theme (dark) (+16 screenshots); skipLayout, because the page is the running dashboard whose
  //   header CSS every existing dashboard layout route already measures at 1280/900/700/699/480 (inside-* at 320),
  //   and these pages would only add two pre-existing clips outside this ticket (see `headerVariants`).
  // T1400 (@ui:UI-R57): the planning session link's hover card — `header-planning-card` at wide/mid/narrow (focus
  //   opens it at 0 ms) and the tight twin's ⋯ menu, 4 x 1 theme (dark) (+4 screenshots); skipLayout, because the page
  //   is the running dashboard whose header CSS every existing layout route already measures (as T1396 above).
  // T1401 (@ui:UI-R57): panel-pr-checks-pending-wide — an open PR waiting on pending checks alone
  //   (no status chip, no wait/blocked chip, no readiness box) beside a draft that keeps its chip.
  //   1 theme (dark), wide only (+1 screenshot); skipLayout, because the panel routes already measure the page.
  // T1403 (@ui:UI-R57): inside-ship-deliver-base-check — the Push row's pre-push base check, one phase heading and
  //   one row per gate of the current run. 1 theme (dark) (+1 screenshot) and 1 new page x 8 widths (+8 layout runs).
  // T1413 (@ui:UI-R57): the Models button's card open on focus (`header-models-card-*`), row 2 with relations only
  //   (`header-relations-*`) and the urgent needs-you ticket whose row 2 hides (`header-needs-you-urgent-*`),
  //   3 families x 4 tiers x 1 theme (dark) (+12 screenshots); skipLayout, as T1396 above.
  // T1410 (@ui:UI-R57, @ui:VISUAL-VARIANTS): the Ship auto-fix rounds as one tab row. Five new states (one round with
  //   no tabs, R1 conflict + R2 CI live, R1/R2/R3 spent, a historical R1, a round with no push) at 1 theme (+5
  //   screenshots), the spent case also at mid/narrow/tight (+3), and 5 new pages x 8 widths (+40 layout runs).
  // T1418 (@ui:VISUAL-VARIANTS, @ui:UI-R22): a graph node's details card open over the minimal node row (dark, light,
  //   hc: +3 screenshots) and over a Graph view chip (dark: +1) — 4 screenshots; skipLayout, because both pages
  //   already own a layout run and the layout gate opens no card.
  dashboard: { screenshots: 394, layout: 912 },
  // T1298 one-commit (the singular count texts), @ui:UI-R57: 1 theme (+1 screenshot); skipLayout, because the populated route already runs the page.
  // T1316 clean / many-files / refresh-failed / diffs-narrow / diffs-tight (DF-23), @ui:UI-R57: 5 variants x 1 theme (+5 screenshots);
  //   clean, many-files and refresh-failed add 3 pages x 8 widths (+24), the narrow/tight variants share the populated run, and DF-21
  //   opens the 400/399/320 tier probes for all 8 diffs pages (5 x 3 existing pages = +15).
  diffs: { screenshots: 13, layout: 64 },
  // T1328 GS-14 (@ui:RD-TIERS): Getting Started opens the 400/399/320 tight probes (+3 widths per page).
  //   GS-4 and GS-5 add the `fresh`, `returning` and `agent-missing` variants (+3 screenshots in dark, +3 layout pages),
  //   and the `error` variant now posts a `state-error` page of its own. Nine pages x 8 widths = 72 layout runs.
  gettingStarted: { screenshots: 11, layout: 72 },
  // T1317 RS-10 (@ui:UI-R57): the eight `resources--servers-*` variants of the Servers tab, which had
  // no baseline at all. Screenshots: servers-mixed in dark/light/hc/grayscale (+4), servers-failed in
  // dark/light/hc (+3), servers-starting in dark and reduced-motion (+2), and none/done/unavailable/
  // hostile/crashed in dark (+5) = +14. Layout: eight new pages x 5 widths (+40).
  resources: { screenshots: 24, layout: 80 },
  // T1298 search-one-match (the single-match text from the new host reply pair), @ui:UI-R57: 1 theme (+1 screenshot); skipLayout, because the page adds no layout.
  // T1317 LG-1/LG-8/LG-11, @ui:UI-R57: serverLogs--truncated, --no-services and --unreadable (1 theme each,
  // +3 screenshots; +2 distinct pages x 5 widths = +10 layout runs, because --no-services sends the same
  // zero-service `server-logs` message as `empty` and so shares its page), and --long-content-nowrap (+1
  // screenshot; it shares the long-content layout run, since Wrap off is a click, not a different page).
  // T1357 empty is now a service with an empty log, not the no-services page, @ui:VISUAL-VARIANTS (+5 layout: the two no longer share one layout run).
  serverLogs: { screenshots: 13, layout: 45 },
  // T1228 accounts-sbx-token (the sbx token cell, set and not set), @ui:UI-R57: 3 themes (+3 screenshots); skipLayout, because accounts-several already runs the same route.
  // T1237 the Sandbox tab route (#agents/sandbox), @ui:UI-R57: 3 themes (+3 screenshots) and 6 layout widths (+6); agents-sandbox-error: 1 theme (dark) (+1 screenshot); skipLayout.
  // T1236 nav-narrow variants (the nav chip row on general, agents roles and autopilot at 630 and 320 px), @ui:UI-R57: 6 variants x 1 theme (+6 screenshots); skipLayout, because the route layout runs already cover these routes.
  // T1239 roles-narrow-collapsed / roles-narrow-expanded / roles-tight-collapsed (the summary row, one row open, and 320 px), @ui:UI-R57: 3 variants x 1 theme (dark) (+3 screenshots); skipLayout, because the roles route layout runs already cover every width.
  // T1241 accounts-quota (the Subscription quota card with saved values), @ui:UI-R57: 3 themes (+3 screenshots); skipLayout, because accounts-several already runs the same route.
  // T1266 roles-graph / roles-graph-narrow / roles-graph-tight (the graph role rows with hint and inherited text, wide, 630 and 320 px), @ui:UI-R57: 3 variants x 1 theme (dark) (+3 screenshots); skipLayout, because the roles route layout runs already cover every width.
  // T1297 SET-63 Settings routes capture light and HC too (14 routes x 2 themes, +28 screenshots).
  // T1297 new variants, @ui:UI-R57: discard-undo, ticketing-manual, ticketing-clickup, repositories-long-path,
  //   roles-no-presets, roles-mid, approaches-graph(-mid/-narrow) — 9 x 1 theme (dark) (+9 screenshots); all skipLayout.
  // T1297 SET-1 the settings routes also open 399 and 320 px (16 routes x 2 widths, +32 layout runs).
  // T1360 accounts-not-signed-in / accounts-narrow (the flat table's row states, and its stacked cards at 480 px),
  //   @ui:UI-R57: 2 x 1 theme (dark) (+2 screenshots); skipLayout, because accounts-several already runs the route.
  // T1360 review accounts-long-name (one 50-char unbroken name, the UI-R44 wrapping case), @ui:UI-R57: 1 theme
  //   (dark) (+1 screenshot); skipLayout, because accounts-several already runs the route.
  // T1368 accounts-quota-narrow (the compact quota list at 400 px: label, help, control under them), @ui:UI-R57:
  //   1 theme (dark) (+1 screenshot); skipLayout, because the wide accounts-quota shot already covers the route.
  // T1373 quality-oom-narrow (a gate as a card at 400 px), @ui:UI-R55, @ui:UI-R57: 1 theme (dark) (+1 screenshot);
  //   skipLayout, because the quality route layout runs already cover every width.
  // T1374 (D834, @ui:UI-R57): the graph card's agents, limits and planner prompt moved into its Edit drawer, so the three
  //   approaches-graph shots now open that drawer, and the roster gets its own wide and narrow shots; the git-sourced
  //   drawer adds one more. All four families are skipLayout, so the layout count is unchanged (+3 screenshots).
  // T1405 (D841, @ui:UI-R57, @ui:VISUAL-VARIANTS): the read-only Channels map. The two route variants
  //   (`#agents/channels` and `#agents/channels/antigravity`) capture at ALL_THEMES (+6 screenshots) and open 2 new
  //   Agents pages at every SETTINGS_LAYOUT_WIDTHS width plus their resize test (+16 layout runs); the narrow (630) and
  //   tight (320) shots are skipLayout, because those route runs already cover the widths (+2 screenshots).
  settings: { screenshots: 131, layout: 172 },
  // T1099 stage-chip tier variants, @ui:UI-R57: 2 widths x 2 themes (+4 screenshots).
  // T1103 waits-on variants (a row with 3 references and its +N list), @ui:UI-R57: 2 widths x 2 themes (+4 screenshots) and their layout runs (+5).
  // T1104 queue-chips variants (the Queue pane open, verb + chip on one line and on two), @ui:UI-R57: 2 widths x 2 themes (+4 screenshots) and their layout runs (+5).
  // T1171 peek-460 / peek-300 variants (every state family's open row), @ui:RD-TIERS: 2 widths x 2 themes (+2 screenshots as counted) and their layout runs (+5).
  // T1213 planning-artifacts variants (Open artifacts icon on a planning row), @ui:RD-TIERS: 2 widths x 2 themes (+4 screenshots) and their layout runs (+5).
  // T1269 Activity pane variants (empty, populated, long content, 460 and 300 tiers), @ui:RD-TIERS: 7 screenshots (3 variants in dark, 2 widths in dark and light) and their layout runs (+15).
  // T1298 attention-one (the "1 needs you · 1 failed" attention line), @ui:UI-R57: 1 theme (+1 screenshot); skipLayout, because it opens the populated page.
  // T1318 SB-3 (@ui:RD-TIERS, @ui:UI-R57): every sidebar shot records the real 300 px width. The five tier families
  // (queue-chips, activity, stage-chip, waits-on, planning-artifacts) add the 320 step and the hc theme (5 x (2 x 3 + 3)
  // = +25 screenshots); peek-states adds the 320 and 460 widths and the two shape projects (+3); the new states
  // (populated-300, host-error, peek-blocked-300, peek-pr-closed-300, row-hover-300) add 5, and filtered/peek are renames.
  // The three new pages (populated-300, peek-blocked-300, peek-pr-closed-300) add 3 x 5 layout widths (+15); every other
  // width or theme change shares its page's run.
  sidebar: { screenshots: 75, layout: 110 },
  // T1266 graph-roles (the settings region lists expert / worker / fast for a graph approach), @ui:UI-R57: 1 theme (dark) (+1 screenshot) and its layout runs (+5).
  // T1301 agent-picker-open (the open agent-core menu at the wide 799-tall window, RD-AGENT-MENU), @ui:UI-R57: 1 theme (dark) (+1 screenshot); the page shares the edit-core-model layout run, so no layout tests are added.
  // T1301 SET-63 realistic-create / graph-roles / error at ALL_THEMES, SET-56's HC realistic-create-switches (Auto-improve Off), and SET-65's open approach picker, @ui:UI-R57: 7 screenshots (3 variants x 2 added themes = +6, the HC switch variant = +1); skipLayout, because the switch toggle adds no geometry and the realistic create page already runs it.
  // T1308 graph-roles-legacy-core / graph-roles-legacy-core-tight-320 (a graph ticket with a stale core: the preset-only picker, arch:AC-63), @ui:UI-R57: 2 variants x 1 theme (dark) (+2 screenshots) and their layout runs (+5).
  // T1357 realistic-create removed: the populated page now renders the same realistic create state at ALL_THEMES, @ui:VISUAL-VARIANTS (-3 screenshots; the layout run stays, now under populated).
  ticketForm: { screenshots: 38, layout: 100 },
  // T1302 state matrix (@ui:UI-R57): populated-narrow/tight, long-key wide + mid, host-failure, and the five
  // quota states (+14 screenshots); their layout runs add 6 distinct pages x 6 widths and 8 pages x the 360 tier (+44).
  usage: { screenshots: 24, layout: 84 },
};

/** The settings layout tests of `layout.layout.ts`: every route at every width, plus the Agents resize test. */
function settingsRouteTests(): number {
  return settingsRoutes().reduce((n, r) => n + SETTINGS_LAYOUT_WIDTHS.length + (r.section === 'agents' ? 1 : 0), 0);
}

export function sweepCounts(): Readonly<Record<ViewId, SweepCount>> {
  const layout = new Map<ViewId, number>();
  for (const t of extraLayoutTargets()) layout.set(t.view, (layout.get(t.view) ?? 0) + layoutWidthsFor(t.view, t.variant.id).length);
  return Object.fromEntries(
    WEBVIEW_NAMES.map((view) => [
      view,
      {
        screenshots: VARIANTS[view].reduce((n, v) => n + v.themes.length, 0),
        layout: (layout.get(view) ?? 0) + (view === 'settings' ? settingsRouteTests() : 0),
      },
    ]),
  ) as unknown as Record<ViewId, SweepCount>;
}
