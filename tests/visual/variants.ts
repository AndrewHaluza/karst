/**
 * The variant registry (ui:UI-R57, ui:VISUAL-VARIANTS): every webview in
 * WEBVIEW_NAMES maps to the variants it declares, and every variant carries
 * (a) its corpus builder, (b) the baseline name and theme projects the sweep
 * records, and (c) the layout-gate target that opens its page at every LAYOUT_WIDTHS
 * width (shared when an earlier variant opens the same page, see layoutPlan()).
 * variants.test.ts fails when any of the three is missing.
 *
 * Builders reuse the render-fixture corpora and realisticSettings.ts so the
 * sweep and the render tests pin the same states. All data is fixed: no clock,
 * no random ids.
 */
import { WEBVIEW_NAMES } from '../../src/model/webviewChains.js';
import { layoutWidthsFor } from '../../src/ui/layout/layoutBreakpoints.js';
import { captureTargetFor, type Variant, type ViewId } from './variantCore.js';
import { INSIDE_CASE_CLICK, INSIDE_CASE_CLICKS, INSIDE_CASE_WIDTHS, dashboardVariants } from './variants/dashboard.js';
import { diffsVariants } from './variants/diffs.js';
import { gettingStartedVariants } from './variants/gettingStarted.js';
import { resourcesVariants } from './variants/resources.js';
import { serverLogsVariants } from './variants/serverLogs.js';
import { settingsVariants } from './variants/settings.js';
import { sidebarVariants } from './variants/sidebar.js';
import { ticketFormVariants } from './variants/ticketForm.js';
import { usageVariants } from './variants/usage.js';

export {
  ALL_THEMES,
  CAPTURE_TARGET_FAMILIES,
  DARK_ONLY,
  MANDATORY_VARIANTS,
  captureTargetFor,
  screenshotFullPage,
  screenshotTarget,
} from './variantCore.js';
export type {
  AgentPopoverSteps,
  CaptureMode,
  CaptureTargetFamily,
  RuntimeOpen,
  TicketDetailsSteps,
  Variant,
  ViewId,
} from './variantCore.js';
export { INSIDE_CASE_CLICK, INSIDE_CASE_CLICKS, INSIDE_CASE_WIDTHS } from './variants/dashboard.js';

/**
 * T1364 (@ui:VISUAL-VARIANTS): attach the element target of every component-focused dashboard variant. The family map
 * and the page-capture keep rules live in one place (`captureTargetFor`); other views keep full-page shots.
 */
const withCaptureTargets = (variants: readonly Variant[]): Variant[] =>
  variants.map((v) => {
    const target = captureTargetFor(v);
    return target === undefined ? v : { ...v, captureTarget: target };
  });

const BUILDERS: Readonly<Record<ViewId, () => Variant[]>> = {
  dashboard: () => withCaptureTargets(dashboardVariants()),
  diffs: diffsVariants,
  gettingStarted: gettingStartedVariants,
  resources: resourcesVariants,
  serverLogs: serverLogsVariants,
  settings: settingsVariants,
  sidebar: sidebarVariants,
  ticketForm: ticketFormVariants,
  usage: usageVariants,
};

/** view → declared variants, in declaration order. Builders run lazily per call. */
export const VARIANTS: Readonly<Record<ViewId, readonly Variant[]>> = Object.fromEntries(
  WEBVIEW_NAMES.map((v) => [v, BUILDERS[v]()]),
) as unknown as Record<ViewId, readonly Variant[]>;

/** Fixture page file (inside each theme folder) for one variant. */
export function fixtureFile(view: ViewId, variantId: string): string {
  return `${view}--${variantId}.html`;
}

export interface LayoutTarget {
  /** Report / ledger id: `<view>/<variant>`, or the existing settings route id. */
  readonly id: string;
  readonly view: ViewId;
  readonly variant: Variant;
}

/** A clock value in a corpus (`stageSince`, `startedAt`): the layout gate measures geometry, not the time text. */
const ISO_TIMESTAMP = /\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z/g;

/**
 * What decides the page the layout gate measures for a variant (@ui:VISUAL-VARIANTS): the view, the widths, the
 * fixture page (`buildFixture` reads only the corpus messages and view state) and the steps `layout.layout.ts` runs
 * (`clicks` only). Screenshot fields (`width`, `themes`, `capture`, `captureTarget`, `viewportHeight`, `click`, `pills`, the popover
 * and drawer steps) are not part of it. Add a field here when `layout.layout.ts` starts to run it.
 */
export function layoutIdentity(view: ViewId, variant: Variant): string {
  const corpus = variant.corpus();
  return JSON.stringify([view, layoutWidthsFor(view, variant.id), corpus.messages, corpus.viewState ?? null, variant.clicks ?? []]).replace(
    ISO_TIMESTAMP,
    '<time>',
  );
}

export interface LayoutPlan {
  readonly targets: readonly LayoutTarget[];
  /** `<view>/<variant>` of a variant whose page an earlier target already measures → the id of that target. */
  readonly sharedWith: ReadonlyMap<string, string>;
}

let plan: LayoutPlan | undefined;

/**
 * Layout-gate runs, one per distinct page (ui:UI-R57). A variant that opens the same page as an earlier variant (it
 * differs only in screenshot fields, e.g. a tier variant with its own `width`) shares that run: the gate already opens
 * the page at every width. Settings route variants keep their settingsRoutes() id and are never shared.
 */
export function layoutPlan(): LayoutPlan {
  if (plan !== undefined) return plan;
  const targets: LayoutTarget[] = [];
  const sharedWith = new Map<string, string>();
  const firstById = new Map<string, string>();
  for (const view of WEBVIEW_NAMES) {
    for (const variant of VARIANTS[view].filter((v) => !v.skipLayout)) {
      const id = variant.layoutRouteId ?? `${view}/${variant.id}`;
      if (variant.layoutRouteId === undefined) {
        const key = layoutIdentity(view, variant);
        const first = firstById.get(key);
        if (first !== undefined) {
          sharedWith.set(id, first);
          continue;
        }
        firstById.set(key, id);
      }
      targets.push({ id, view, variant });
    }
  }
  plan = { targets, sharedWith };
  return plan;
}

/** Layout-gate runs, one per distinct page; settings route variants reuse their settingsRoutes() id. */
export function layoutTargets(): readonly LayoutTarget[] {
  return layoutPlan().targets;
}

/** Layout targets that are not settings routes: settings routes keep their settingsRoutes() runs. */
export function extraLayoutTargets(): readonly LayoutTarget[] {
  return layoutTargets().filter((t) => t.variant.layoutRouteId === undefined);
}
