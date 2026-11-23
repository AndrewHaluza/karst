import { stagePaletteCss } from './stagePalette.js';

/**
 * The unified stages/states color system (§ Phase E) — single source of truth.
 *
 * Every webview used to re-declare its own colors (three greens, two grays, two
 * naming schemes). Instead, one `:root` block is emitted here and injected into
 * each `webview.html` at load (CSP forbids a shared stylesheet). VS Code chart
 * variables track the user's theme; the hexes are fallbacks. The semantic
 * mapping still lives in [[glyph]] — this only fixes the color VALUES.
 *
 * Legacy `--g-*` (sidebar) and `--st-*` (dashboard) names are aliased to the
 * canonical `--k-*` tokens so existing markup resolves to the unified values
 * without rewriting every reference. Because the injected block is placed AFTER
 * each file's own `<style>` (via the marker), these aliases win the cascade.
 */

/** Canonical semantic tokens: name → theme-aware value (chart var + hex fallback). */
export const PALETTE_TOKENS = {
  /** pending · idle · skipped · offline track */
  pending: 'var(--vscode-charts-lines, #6e7681)',
  /** stage or agent working */
  running: 'var(--vscode-charts-blue, #3794ff)',
  /** needs you (agent waiting) */
  attention: 'var(--vscode-charts-yellow, #cca700)',
  /** passed · done · server online */
  passed: 'var(--vscode-charts-green, #4bb64b)',
  /** failed · blocked */
  failed: 'var(--vscode-charts-red, #f14c4c)',
} as const;

/**
 * `--k-<state>-fg`: the readable tone of each status glyph, per theme (UI-R28 / UI-R28b, UI-R29).
 *
 * The semantic tokens above are the user's theme chart hues, and a chart hue is a border/fill colour: on the
 * sidebar surface the pending gray reads 3.33:1 (dark) and 1.71:1 (light charts-lines), the failed red 4.29:1,
 * and the light passed green 4.32:1 — below the 4.5:1 a text glyph needs. `.k-status` paints a character, so it
 * uses these tones: the same hue, lightened or darkened until it clears AA on the row surface. The hc surface is
 * black, where the dark tones clear as well.
 */
export const STATUS_FG = {
  pending: { dark: '#8b949e', light: '#5f5f5f' },
  running: { dark: '#3794ff', light: '#0062a3' },
  attention: { dark: '#f0c400', light: '#6f4f02' },
  passed: { dark: '#4bb64b', light: '#0f7b4f' },
  failed: { dark: '#f85149', light: '#c72e0f' },
} as const;

/** The attention tone predates the five-glyph ramp and is quoted by name (needs-you chip text). */
export const ATTENTION_FG = STATUS_FG.attention;

/** Placeholder swapped for the palette block; sits inside each webview's `<style>`. */
export const PALETTE_MARKER = '/*KARST_PALETTE*/';

/** The `:root` block: canonical `--k-*` tokens plus legacy aliases. */
export function paletteCss(): string {
  const t = PALETTE_TOKENS;
  return (
    ':root{' +
    `--k-pending:${t.pending};` +
    `--k-running:${t.running};` +
    `--k-attention:${t.attention};` +
    `--k-passed:${t.passed};` +
    `--k-failed:${t.failed};` +
    // The glyph tones (UI-R29): a chart hue is a fill colour, not small text. Dark is the base; the light
    // block below overrides each one (the light chart gray is the worst at 1.71:1).
    `--k-pending-fg:${STATUS_FG.pending.dark};` +
    `--k-running-fg:${STATUS_FG.running.dark};` +
    `--k-attention-fg:${STATUS_FG.attention.dark};` +
    `--k-passed-fg:${STATUS_FG.passed.dark};` +
    `--k-failed-fg:${STATUS_FG.failed.dark};` +
    // The findings severity ramp — ONE definition for the inside block's
    // evidence rows and the Artifacts panel's finding cards. Before this the
    // two surfaces mapped the same five levels differently (Artifacts drew
    // `critical` and `high` in one red; the inside block drew `high` amber),
    // so a reader had to know which surface they were on to read a level.
    // Defined as references to the status tokens above, so the ramp tracks
    // the user's theme through them and introduces no new hue.
    '--k-sev-critical:var(--k-failed);' +
    '--k-sev-high:var(--k-attention);' +
    '--k-sev-medium:var(--k-running);' +
    '--k-sev-low:var(--k-text-dim);' +
    '--k-sev-info:var(--k-text-faint);' +
    // Legacy sidebar aliases (glyph classes).
    '--g-running:var(--k-running);--g-input:var(--k-attention);--g-failed:var(--k-failed);' +
    '--g-done:var(--k-passed);--g-gray:var(--k-pending);' +
    // Legacy dashboard aliases (stepper / agent pill / server dots).
    '--st-running:var(--k-running);--st-input:var(--k-attention);--st-failed:var(--k-failed);' +
    '--st-done:var(--k-passed);--st-pending:var(--k-pending);' +
    '}' +
    `body.vscode-light{` +
    `--k-pending-fg:${STATUS_FG.pending.light};` +
    `--k-running-fg:${STATUS_FG.running.light};` +
    `--k-attention-fg:${STATUS_FG.attention.light};` +
    `--k-passed-fg:${STATUS_FG.passed.light};` +
    `--k-failed-fg:${STATUS_FG.failed.light}}` +
    // The stage ramp ships through the same marker: one injection point, so a
    // webview cannot end up with status colors but no stage colors.
    stagePaletteCss()
  );
}

/** Replace the palette marker with the emitted block; no-op if absent. */
export function injectPalette(html: string): string {
  return html.replace(PALETTE_MARKER, `${paletteCss()}`);
}
