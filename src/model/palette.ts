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
    // Legacy sidebar aliases (glyph classes).
    '--g-running:var(--k-running);--g-input:var(--k-attention);--g-failed:var(--k-failed);' +
    '--g-done:var(--k-passed);--g-gray:var(--k-pending);' +
    // Legacy dashboard aliases (stepper / agent pill / server dots).
    '--st-running:var(--k-running);--st-input:var(--k-attention);--st-failed:var(--k-failed);' +
    '--st-done:var(--k-passed);--st-pending:var(--k-pending);' +
    '}' +
    // The stage ramp ships through the same marker: one injection point, so a
    // webview cannot end up with status colors but no stage colors.
    stagePaletteCss()
  );
}

/** Replace the palette marker with the emitted block; no-op if absent. */
export function injectPalette(html: string): string {
  return html.replace(PALETTE_MARKER, `${paletteCss()}`);
}
