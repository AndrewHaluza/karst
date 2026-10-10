/**
 * Layout tiers shared by the layout-sanity gate and (as new CSS migrates) the
 * webview stylesheets. CSS custom properties cannot drive `@media`, so this
 * constant is the single source; layoutBreakpoints.test.ts pins the `@media`
 * widths of the allowlisted CSS files to it.
 *
 * Tiers: wide >= 1000, mid 700-999, narrow <= 699.
 */

export const WIDE_MIN = 1000;
export const NARROW_MAX = 699;

export type LayoutTier = 'wide' | 'mid' | 'narrow';

/** Viewport widths the gate opens: both sides of each boundary + a narrow split. */
export const LAYOUT_WIDTHS: readonly number[] = [1280, 900, 700, 699, 480];
export const LAYOUT_HEIGHT = 900;

export function tierFor(width: number): LayoutTier {
  if (width >= WIDE_MIN) return 'wide';
  return width <= NARROW_MAX ? 'narrow' : 'mid';
}
