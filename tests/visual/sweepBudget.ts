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
  dashboard: { screenshots: 582, layout: 685 },
  diffs: { screenshots: 7, layout: 25 },
  gettingStarted: { screenshots: 8, layout: 30 },
  resources: { screenshots: 10, layout: 40 },
  serverLogs: { screenshots: 8, layout: 30 },
  settings: { screenshots: 62, layout: 118 },
  sidebar: { screenshots: 16, layout: 65 },
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
