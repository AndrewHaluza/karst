/**
 * Layout tiers shared by the layout-sanity gate and (as new CSS migrates) the
 * webview stylesheets. CSS custom properties cannot drive `@media`, so this
 * constant is the single source; layoutBreakpoints.test.ts pins the `@media`
 * widths of the allowlisted CSS files to it.
 *
 * Tiers: wide >= 1000, mid 700-999, narrow 400-699, tight <= 399.
 */

export const WIDE_MIN = 1000;
export const NARROW_MAX = 699;
export const TIGHT_MAX = 399;

export type LayoutTier = 'wide' | 'mid' | 'narrow' | 'tight';

/** Viewport widths the gate opens: both sides of each boundary + a narrow split. */
export const LAYOUT_WIDTHS: readonly number[] = [1280, 900, 700, 699, 480];
export const LAYOUT_HEIGHT = 900;

/**
 * The Token usage page also proves the tight tier (`@ui:RD-TIERS`): its by-ticket table turns into cards at
 * `399px` and below, so the gate opens the 360 host floor on every usage page.
 */
export const USAGE_EXTRA_WIDTHS: readonly number[] = [360];

/**
 * The extra probes of the Inside block: both sides of the tight boundary, plus the 320 floor (ui:RD-GATE item 1).
 * This departs from the global widening on purpose: other regions keep the 480 floor until their own ticket.
 */
export const INSIDE_EXTRA_WIDTHS: readonly number[] = [400, 399, 320];

const INSIDE_VARIANT_PREFIX = 'inside-';

/**
 * The widths the gate opens for one target. Token usage adds the 360 tight floor; only an `inside-*`
 * dashboard variant adds the tight probes.
 */
export function layoutWidthsFor(view: string, variantId: string): readonly number[] {
  if (view === 'usage') return [...LAYOUT_WIDTHS, ...USAGE_EXTRA_WIDTHS];
  return view === 'dashboard' && variantId.startsWith(INSIDE_VARIANT_PREFIX) ? [...LAYOUT_WIDTHS, ...INSIDE_EXTRA_WIDTHS] : LAYOUT_WIDTHS;
}

export function tierFor(width: number): LayoutTier {
  if (width >= WIDE_MIN) return 'wide';
  if (width > NARROW_MAX) return 'mid';
  return width <= TIGHT_MAX ? 'tight' : 'narrow';
}
