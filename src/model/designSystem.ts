import { tokensCss } from './designTokens.js';
import { componentsCss, DS_CSS_MARKER } from './designComponents.js';
import { designRuntimeJs, DS_JS_MARKER } from './designRuntime.js';

/**
 * The design system's single injection point (§ `docs/ui/DESIGN-SYSTEM.md` §1).
 *
 * Every webview is a self-contained document under `default-src 'none'` with no
 * `<link>` and no external `<script>`. That is an ARCHITECTURE choice, not a CSP
 * impossibility — an extension-local `asWebviewUri` stylesheet under a matching
 * `style-src` would load fine (DESIGN-SYSTEM §1). Karst keeps the self-contained
 * document, so the system ships the way [[palette]] and [[providerIdentity]]
 * already do: a marker in the HTML, a TS module emitting text, one host-side
 * inject call. No second delivery mechanism, and no UI framework (UI-R01).
 *
 * Ordering is load-bearing in three ways:
 *
 *  - `/*KARST_DS_CSS*\/` sits at the TOP of each file's own `<style>`, so a
 *    file-local rule can still win while that screen is being migrated. A fully
 *    remediated screen has nothing left to override.
 *  - `/*KARST_PALETTE*\/` keeps its place in the TRAILING `<style>`, so the
 *    `--k-*` status ramp still wins the cascade. The feedback tokens alias onto
 *    that ramp, so they must resolve after it.
 *  - `injectDesignSystem` must run BEFORE `injectCsp`, or the emitted runtime
 *    lands in a `<script>` that the nonce pass has already walked past and the
 *    browser refuses to execute it.
 */

export { DS_CSS_MARKER, DS_JS_MARKER };

/** Tokens then primitives — primitives reference tokens, so this order is required. */
export function designSystemCss(): string {
  return `${tokensCss()}\n${componentsCss()}`;
}

/**
 * Replace both markers. No-op per marker if absent — same contract as
 * `injectPalette`/`injectProviderIdentity`, so a document that has not opted in
 * passes through intact rather than being half-wired.
 *
 * A function replacer, not a string: `String.replace` treats `$&`, `$'` and
 * friends in a string replacement as substitutions, and the emitted CSS/JS is
 * generated text that must land verbatim.
 */
export function injectDesignSystem(html: string): string {
  return html
    .replace(DS_CSS_MARKER, () => designSystemCss())
    .replace(DS_JS_MARKER, () => designRuntimeJs());
}
