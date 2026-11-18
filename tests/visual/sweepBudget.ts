/**
 * Sweep budget ratchet (@ui:SWEEP-BUDGET): the number of screenshots and layout tests each view adds to the visual
 * UAT gate. The sweep has one slot and one 45 min limit, and every later ticket pays for each test a change adds, so a
 * change that grows a view must say why here. `sweepBudget.test.ts` fails when a count moves: above the budget, raise
 * the number and add the reason in a comment beside it; below the budget, lower the number (shrink is free).
 *
 * Counts come from the registry alone (no Playwright run), the same way the specs build their tests:
 * - screenshots: one per variant x declared theme project (`pages.visual.ts`; a test in another project is a skip);
 * - layout: one per layout target x width (`layout.layout.ts`, shared pages counted once, see `layoutPlan()`),
 *   plus the settings routes x LAYOUT_WIDTHS and one resize test per Agents route.
 */
import { LAYOUT_WIDTHS, layoutWidthsFor } from '../../src/ui/layout/layoutBreakpoints.js';
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
  dashboard: { screenshots: 606, layout: 714 },
  diffs: { screenshots: 7, layout: 25 },
  gettingStarted: { screenshots: 8, layout: 30 },
  resources: { screenshots: 10, layout: 40 },
  serverLogs: { screenshots: 8, layout: 30 },
  // T1228 accounts-sbx-token (the sbx token cell, set and not set), @ui:UI-R57: 3 themes (+3 screenshots); skipLayout, because accounts-several already runs the same route.
  // T1237 the Sandbox tab route (#agents/sandbox), @ui:UI-R57: 3 themes (+3 screenshots) and 6 layout widths (+6); agents-sandbox-error: 1 theme (dark) (+1 screenshot); skipLayout.
  // T1236 nav-narrow variants (the nav chip row on general, agents roles and autopilot at 630 and 320 px), @ui:UI-R57: 6 variants x 1 theme (+6 screenshots); skipLayout, because the route layout runs already cover these routes.
  // T1239 roles-narrow-collapsed / roles-narrow-expanded / roles-tight-collapsed (the summary row, one row open, and 320 px), @ui:UI-R57: 3 variants x 1 theme (dark) (+3 screenshots); skipLayout, because the roles route layout runs already cover every width.
  settings: { screenshots: 78, layout: 124 },
  // T1099 stage-chip tier variants, @ui:UI-R57: 2 widths x 2 themes (+4 screenshots).
  // T1103 waits-on variants (a row with 3 references and its +N list), @ui:UI-R57: 2 widths x 2 themes (+4 screenshots) and their layout runs (+5).
  // T1104 queue-chips variants (the Queue pane open, verb + chip on one line and on two), @ui:UI-R57: 2 widths x 2 themes (+4 screenshots) and their layout runs (+5).
  // T1171 peek-460 / peek-300 variants (every state family's open row), @ui:RD-TIERS: 2 widths x 2 themes (+2 screenshots as counted) and their layout runs (+5).
  // T1213 planning-artifacts variants (Open artifacts icon on a planning row), @ui:RD-TIERS: 2 widths x 2 themes (+4 screenshots) and their layout runs (+5).
  sidebar: { screenshots: 34, layout: 80 },
  ticketForm: { screenshots: 30, layout: 90 },
  usage: { screenshots: 10, layout: 40 },
};

/** The settings layout tests of `layout.layout.ts`: every route at every width, plus the Agents resize test. */
function settingsRouteTests(): number {
  return settingsRoutes().reduce((n, r) => n + LAYOUT_WIDTHS.length + (r.section === 'agents' ? 1 : 0), 0);
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
