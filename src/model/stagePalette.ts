import { STAGE_KEYS, type StageKey } from './types.js';

/**
 * The stage→color map (§ stage colors) — single source of truth for WHERE a
 * ticket is, as opposed to [[palette]]'s `--k-*` ramp, which says whether it
 * needs you. Both appear in one sidebar row (status dot on the left, stage chip
 * on the right) and on one dashboard rail, so they must stay legible as two
 * separate claims: no stage may borrow a status color for an unrelated meaning.
 * `impl` used to be VS Code's chart blue — the same blue as "In progress" — and
 * a running impl ticket read blue twice for two different reasons.
 *
 * Values are literal hexes rather than `--vscode-charts-*` vars: only four of
 * the seven stages have a chart var in the hue they need, and mixing the two
 * sources made the palette drift per theme. Each stage carries a dark and a
 * light value, both chosen to clear text contrast on the washed-out chip fill
 * (`color-mix(currentColor 14–18%, transparent)`).
 *
 * Injected as text into each `webview.html` through [[palette]]'s existing
 * marker (CSP forbids a shared stylesheet), so the dashboard rail and the list
 * chip resolve the same token and can never diverge.
 */

/** One stage's color in each theme. */
export interface StageColor {
  dark: string;
  light: string;
}

/**
 * Two deliberate overlaps with the status ramp remain, because the meanings
 * genuinely coincide there: `fix` is red like Blocked, `done` is green like
 * Done. Every other stage sits off the ramp.
 */
export const STAGE_COLORS: Readonly<Record<StageKey, StageColor>> = {
  scope: { dark: '#a371f7', light: '#8250df' },
  impl: { dark: '#7f7bf5', light: '#4f46e5' },
  uat: { dark: '#d18616', light: '#b45309' },
  review: { dark: '#2ea8b5', light: '#0e7490' },
  fix: { dark: '#f14c4c', light: '#c93636' },
  ship: { dark: '#d162c4', light: '#bf3989' },
  // Exactly the status ramp's green (#4bb64b), not a second one: [[palette]]
  // asserts the product ships one green, and `done` is the case where the stage
  // and the status mean the same thing.
  done: { dark: '#4bb64b', light: '#1a7f37' },
};

/**
 * The bucket for a stage this build has never heard of — a row written by a
 * newer schema, or a stage since removed from the graph. Named like a stage so
 * it flows through the same token/class machinery; neutral so it reads as
 * "unclassified" rather than as a seventh workflow step.
 */
export const STAGE_FALLBACK_KEY = 'unknown';

const FALLBACK_COLOR: StageColor = { dark: '#7d8590', light: '#6e7681' };

/**
 * CSS class for a stored stage string. Takes `string | null` — never `StageKey` —
 * because the caller's value comes from the database, where an unrecognized
 * stage is a routine possibility, not a type error. Nothing renders uncolored.
 */
export function stageColorClass(stage: string | null | undefined): string {
  const known = STAGE_KEYS.find((k) => k === stage);
  return `stg-${known ?? STAGE_FALLBACK_KEY}`;
}

/** Every stage plus the fallback, in graph order. */
function entries(): [string, StageColor][] {
  return [
    ...STAGE_KEYS.map((k): [string, StageColor] => [k, STAGE_COLORS[k]]),
    [STAGE_FALLBACK_KEY, FALLBACK_COLOR],
  ];
}

/**
 * The `--stage-*` tokens, their color classes, and the light-theme override.
 *
 * Dark is the base and light is the override (not the reverse) to match the
 * rest of the webview CSS, which is authored dark-first with `--vscode-*`
 * fallbacks. High-contrast themes fall through to the dark values, which carry
 * the higher contrast of the two.
 */
export function stagePaletteCss(): string {
  const decls = (pick: (c: StageColor) => string): string =>
    entries()
      .map(([key, color]) => `--stage-${key}:${pick(color)};`)
      .join('');
  // Each class sets BOTH `color` (so text/currentColor read the stage hue) and
  // `--stg-color` (a stable handle on the hue). A filled node overrides its own
  // `color` to knock the glyph out against the fill, which would make
  // `currentColor` resolve to the knockout color — so fills reference
  // `--stg-color`, which the color override cannot disturb.
  const classes = entries()
    .map(([key]) => `.stg-${key}{color:var(--stage-${key});--stg-color:var(--stage-${key})}`)
    .join('');
  return (
    `:root{${decls((c) => c.dark)}}` +
    `body.vscode-light{${decls((c) => c.light)}}` +
    classes
  );
}
