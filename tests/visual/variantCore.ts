/**
 * Shared pieces of the visual variant registry (ui:UI-R57, ui:VISUAL-VARIANTS): the `Variant` shape,
 * the theme sets, the screenshot capture-target rules and the corpus helpers that more than one view
 * builder uses. A view builder lives in `tests/visual/variants/<view>.ts` and imports only from this
 * module, from `src/**` and from the existing view-specific fixture modules.
 */
import type { WebviewName } from '../../src/model/webviewChains.js';
import type { SettingsSection } from '../../src/ui/settings/sections.js';
import type { ViewCorpus } from './corpora.js';

export type { ViewCorpus };

export type ViewId = WebviewName;

/** Theme projects that record a screenshot for a variant. */
export const ALL_THEMES: readonly string[] = ['dark', 'light', 'hc'];
export const DARK_ONLY: readonly string[] = ['dark'];

/** Variants every view must declare (ui:UI-R57). */
export const MANDATORY_VARIANTS = ['populated', 'empty', 'loading', 'error', 'long-content'] as const;

export interface Variant {
  readonly id: string;
  /** Screenshot file stem inside each theme project's baseline folder. */
  readonly baseline: string;
  /** Theme projects that must hold `<baseline>.png`. */
  readonly themes: readonly string[];
  readonly corpus: () => ViewCorpus;
  /** Settings only: the nav section / hash to open before the shot. */
  readonly route?: { readonly section: SettingsSection; readonly hash?: string; readonly scrollTo?: string };
  /** Settings only: id of the settingsRoutes() entry that runs this variant's layout geometry. */
  readonly layoutRouteId?: string;
  /**
   * Screenshot-only: no layout-gate run. The ledger never grows, and a new dashboard route would inherit the
   * page's known failures (rail, PR rows), so a variant that adds no layout of its own opts out.
   */
  readonly skipLayout?: boolean;
  /** Screenshot viewport width override (px); absent = the project default. */
  readonly width?: number;
  /**
   * Screenshot capture mode. Absent = a full-page shot. `viewport` = the visible viewport only, for a fixed overlay
   * whose full-page shot would also record the height of the page below it (@ui:VISUAL-VARIANTS).
   */
  readonly capture?: CaptureMode;
  /**
   * T1364 (@ui:VISUAL-VARIANTS): a CSS selector; the baseline records only this element instead of the page. Set from
   * `CAPTURE_TARGET_FAMILIES` for a component variant; never together with `capture: 'viewport'`.
   */
  readonly captureTarget?: string;
  /** Screenshot viewport height override (px): a short window puts an open popover's trigger near the bottom edge. */
  readonly viewportHeight?: number;
  /**
   * T1396 (@ui:VISUAL-VARIANTS): scroll the page to this y before the shot, so a sticky row records its scrolled state.
   * Screenshot-only (the layout gate never scrolls), so a scrolled variant sets `skipLayout`.
   */
  readonly scrollY?: number;
  /**
   * T1400 (@ui:VISUAL-VARIANTS): dashboard hover cards — focus this selector after load, so a card that opens on
   * keyboard focus (`0 ms`, `@ui:UI-R22`) is open when the shot records it. Screenshot-only like `scrollY`.
   */
  readonly focus?: string;
  /** Dashboard drill-downs: pill names clicked, in order, after the page loads (the restored artifact index shows the pills). */
  readonly pills?: readonly string[];
  /** Dashboard agent popover: open it after load, then pick a core, type a query, pick a capability tab (in that order). */
  readonly agentPopover?: AgentPopoverSteps;
  /** Dashboard ticket details drawer: open it from the doc icon after load, then pick a tab. */
  readonly ticketDetails?: TicketDetailsSteps;
  /** Dashboard runtime strip: open this popover after load (the sandbox details or the ⋯ menu). */
  readonly runtimeOpen?: RuntimeOpen;
  /** Dashboard panels: a selector clicked after load (a popover trigger). */
  readonly click?: string;
  /** Dashboard panels: a selector hovered after load and after any click. */
  readonly hover?: string;
  /**
   * Dashboard panels: blur the focused control after the clicks and the hover. A clicked k-tooltip trigger keeps focus,
   * and its tooltip (shown on focus) then enters the shot only on some runs.
   */
  readonly blur?: true;
  /** Dashboard baseline review: selectors clicked in order after load (open the overlay, then reach a state). */
  readonly clicks?: readonly string[];
  /**
   * Screenshot-only: a field filled after load (a search box), then the host messages the view expects back.
   * `replies` simulate the host's answer on the fixture page, whose `postMessage` stub has no host behind it.
   */
  readonly fill?: { readonly selector: string; readonly text: string };
  readonly replies?: readonly unknown[];
}

export type CaptureMode = 'viewport';

/** The Playwright `fullPage` option for a variant: only a `capture: 'viewport'` variant is not full-page. */
export function screenshotFullPage(v: Pick<Variant, 'capture'>): boolean {
  return v.capture !== 'viewport';
}

/** One dashboard family whose baseline records its target element, not the page (T1364, @ui:VISUAL-VARIANTS). */
export interface CaptureTargetFamily {
  /** Variant-id prefix. */
  readonly prefix: string;
  /** The element the shot records (a CSS selector that already exists in `webview.html`). */
  readonly selector: string;
}

/**
 * T1364 (@ui:VISUAL-VARIANTS): the family -> selector map for component-focused dashboard variants. `#inside` is the
 * existing root; it gets no `data-region` because `layoutSnapshot.ts` records `region` and a new attribute would shift
 * the ledger keys in `layout-known-failures.json`.
 */
export const CAPTURE_TARGET_FAMILIES: readonly CaptureTargetFamily[] = [
  { prefix: 'panel-srv-', selector: '[data-region="servers"]' },
  { prefix: 'panel-wt-', selector: '[data-region="worktrees"]' },
  { prefix: 'panel-pr-', selector: '[data-region="prs"]' },
  { prefix: 'runtime-', selector: '[data-region="runtime"]' },
  { prefix: 'inside-', selector: '#inside' },
];

/** Kept page captures: a fixed popover/menu or a header/runtime change can leave the target element. */
const PAGE_CAPTURE_ID = /^(runtime-.*-open-|inside-.*-menu-open-)/;
const PAGE_CAPTURE_PREFIXES: readonly string[] = [
  // An inline form and a popover in the panel (T1091), opening outside the panel box.
  'panel-wt-base-',
  'panel-pr-ready-info-',
  // The disabled-shell reason shows only in the ⋯ popover (T1357).
  'runtime-shell-off-',
  // A stage menu (fixed) and the three header/runtime-changing cases (T1363).
  'inside-review-menu-retry-only',
  'inside-impl-interrupted',
  'inside-done-closed',
  'inside-scope-needs-you',
  // T1364: these ship cases differ only in the rail outside #inside, so the element shot would collide
  // (`records a distinct picture`); keep the page so the variant's real diff is recorded.
  'inside-ship-failed',
  'inside-ship-merge-blocked',
  'inside-ship-passed',
  // T1364: the two UAT fix-parked cases differ only outside #inside (the inside views are identical).
  'inside-uat-fix-parked-gate',
  'inside-uat-fix-parked-tester',
];

/**
 * T1364 (@ui:VISUAL-VARIANTS): the element a variant records, or undefined for a page capture. A fixed overlay, a
 * popover/menu step, or a header/runtime change keeps the page so its diff is never clipped; when in doubt, keep it.
 */
export function captureTargetFor(
  v: Pick<Variant, 'id' | 'capture' | 'runtimeOpen' | 'agentPopover' | 'ticketDetails'>,
): string | undefined {
  const family = CAPTURE_TARGET_FAMILIES.find((f) => v.id.startsWith(f.prefix));
  if (family === undefined) return undefined;
  if (
    v.capture === 'viewport' ||
    v.runtimeOpen !== undefined ||
    v.agentPopover !== undefined ||
    v.ticketDetails !== undefined ||
    PAGE_CAPTURE_ID.test(v.id) ||
    PAGE_CAPTURE_PREFIXES.some((p) => v.id.startsWith(p))
  ) {
    return undefined;
  }
  return family.selector;
}

/** The selector a variant's baseline records, or undefined for a full-page shot (T1364, @ui:VISUAL-VARIANTS). */
export function screenshotTarget(v: Pick<Variant, 'captureTarget'>): string | undefined {
  return v.captureTarget;
}

/** The interaction steps of a ticket-details drawer variant: open it from the doc icon, then pick a tab. */
export interface TicketDetailsSteps {
  readonly tab?: 'desc' | 'raw';
}

export type RuntimeOpen = 'sandbox' | 'more';

/** The interaction steps of an agent-popover variant. */
export interface AgentPopoverSteps {
  readonly core?: string;
  readonly q?: string;
  readonly cap?: string;
  /** A model id to pick after the core / query / tab steps. */
  readonly model?: string;
}

export function variant(
  view: ViewId,
  id: string,
  corpus: () => ViewCorpus,
  opts: {
    baseline?: string;
    themes?: readonly string[];
    skipLayout?: boolean;
    width?: number;
    capture?: CaptureMode;
    captureTarget?: string;
    viewportHeight?: number;
    scrollY?: number;
    focus?: string;
    pills?: readonly string[];
    agentPopover?: AgentPopoverSteps;
    ticketDetails?: TicketDetailsSteps;
    runtimeOpen?: RuntimeOpen;
    click?: string;
    hover?: string;
    blur?: true;
    clicks?: readonly string[];
    fill?: { readonly selector: string; readonly text: string };
    replies?: readonly unknown[];
  } = {},
): Variant {
  return {
    id,
    baseline: opts.baseline ?? `${view}--${id}`,
    themes: opts.themes ?? DARK_ONLY,
    corpus,
    ...(opts.skipLayout ? { skipLayout: true } : {}),
    ...(opts.width === undefined ? {} : { width: opts.width }),
    ...(opts.capture === undefined ? {} : { capture: opts.capture }),
    ...(opts.captureTarget === undefined ? {} : { captureTarget: opts.captureTarget }),
    ...(opts.viewportHeight === undefined ? {} : { viewportHeight: opts.viewportHeight }),
    ...(opts.scrollY === undefined ? {} : { scrollY: opts.scrollY }),
    ...(opts.focus === undefined ? {} : { focus: opts.focus }),
    ...(opts.pills === undefined ? {} : { pills: opts.pills }),
    ...(opts.agentPopover === undefined ? {} : { agentPopover: opts.agentPopover }),
    ...(opts.ticketDetails === undefined ? {} : { ticketDetails: opts.ticketDetails }),
    ...(opts.runtimeOpen === undefined ? {} : { runtimeOpen: opts.runtimeOpen }),
    ...(opts.click === undefined ? {} : { click: opts.click }),
    ...(opts.hover === undefined ? {} : { hover: opts.hover }),
    ...(opts.blur === undefined ? {} : { blur: opts.blur }),
    ...(opts.clicks === undefined ? {} : { clicks: opts.clicks }),
    ...(opts.fill === undefined ? {} : { fill: opts.fill }),
    ...(opts.replies === undefined ? {} : { replies: opts.replies }),
  };
}

export const stateMessage = (state: unknown): ViewCorpus => ({ messages: [{ type: 'state', state }] });
/** Before the first host message: what the webview renders while it waits. */
export const LOADING: () => ViewCorpus = () => ({ messages: [] });
export const LONG_TITLE =
  'Reconcile the long-running ticket workflow state across every repository worktree after a rebased base branch';

export function fixtureCorpus<T extends { scenario: string; state: unknown }>(
  view: ViewId,
  fixtures: () => readonly T[],
  scenario: T['scenario'],
): () => ViewCorpus {
  return () => {
    const hit = fixtures().find((f) => f.scenario === scenario);
    if (!hit) throw new Error(`${view}: no '${scenario}' render fixture`);
    return stateMessage(hit.state);
  };
}

/** T1091: an open popover whose trigger sits at the bottom edge of a short window flips above it and stays inside the gutter. */
export const BOTTOM_EDGE_HEIGHT = 480;

/** The options of `variant()`; a view builder spreads them into its own helper. */
export type VariantOpts = NonNullable<Parameters<typeof variant>[3]>;
