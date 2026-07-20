/**
 * Ticketing-provider brand identity (§ shared [ICON] Brand) — single source of
 * truth for how a `TicketProvider` renders across webviews: an inline SVG mark
 * plus a title-cased label. Every webview used to re-derive this independently
 * (onboarding had its own copy; dashboard's ticket-link printed the raw
 * lowercase provider string with no icon at all; settings used a plain native
 * `<select>`), so the same board read as three different UI languages.
 *
 * Like [[palette]], this is injected as text into each self-contained
 * `webview.html` at load (CSP forbids a shared script/stylesheet) rather than
 * imported at webview runtime.
 */

/** Provider id → display label. `manual` has no board, so it renders label-only. */
export const PROVIDER_LABELS: Record<string, string> = { clickup: 'ClickUp', manual: 'Manual' };

/**
 * ClickUp's brand mark: the upward peak/arrow in its pink→purple→blue gradient.
 * Inline (CSP forbids external assets); the gradient id is scoped so it renders
 * wherever this is injected without colliding across multiple badges on one page.
 */
export const CLICKUP_SVG =
  // viewBox frames the drawn peak (path + stroke ≈ y 8.8–27.7) rather than a full
  // 36×36 canvas, so the mark fills the badge and sits vertically centered on the
  // brand text instead of floating in the upper third.
  '<svg viewBox="0 8 36 20" width="14" height="14" aria-hidden="true">' +
  '<defs><linearGradient id="cuMark" x1="0" y1="1" x2="1" y2="0">' +
  '<stop offset="0" stop-color="#fd71af"/>' +
  '<stop offset=".55" stop-color="#7b68ee"/>' +
  '<stop offset="1" stop-color="#49ccf9"/>' +
  '</linearGradient></defs>' +
  '<path d="M4 24.5 L18 12 L32 24.5" fill="none" stroke="url(#cuMark)"' +
  ' stroke-width="6.4" stroke-linecap="round" stroke-linejoin="round"/>' +
  '</svg>';

/** Placeholder swapped for the badge CSS; sits inside each webview's `<style>`. */
export const PROVIDER_CSS_MARKER = '/*KARST_PROVIDER_CSS*/';

/** Placeholder swapped for the badge JS; sits as the first statement in each webview's `<script>`. */
export const PROVIDER_JS_MARKER = '/*KARST_PROVIDER_JS*/';

/** The `.provbadge`/`.provicon`/`.provname` rules shared by every provider badge. */
export function providerIdentityCss(): string {
  return (
    '.provbadge{display:inline-flex;align-items:center;gap:5px}' +
    // Unscoped: the mark also stands alone (dashboard key pill), not only inside a badge.
    '.provicon{flex:none;width:14px;height:14px;display:inline-flex}' +
    '.provbadge .provname{font-weight:600}' +
    '.provbadge.manual{opacity:.6;font-weight:400}' +
    '.provbadge.manual .provname{font-weight:400}'
  );
}

/**
 * The JS blob defining `PROVIDER_LABELS`, `CLICKUP_SVG`, and `providerBadgeHtml`
 * in the webview's global script scope. Emitted as plain statements (no wrapping
 * `<script>` tag) so it can be injected as the first lines of an existing block.
 */
export function providerIdentityJs(): string {
  return (
    `const PROVIDER_LABELS = ${JSON.stringify(PROVIDER_LABELS)};\n` +
    `const CLICKUP_SVG = ${JSON.stringify(CLICKUP_SVG)};\n` +
    // Falls back to the raw id (title-cased) for a provider with no known icon/label,
    // so a future provider degrades gracefully instead of rendering blank.
    'function providerBadgeHtml(provider) {\n' +
    '  const p = provider || "manual";\n' +
    '  const known = Object.prototype.hasOwnProperty.call(PROVIDER_LABELS, p);\n' +
    '  const label = known ? PROVIDER_LABELS[p] : (p.charAt(0).toUpperCase() + p.slice(1));\n' +
    '  const icon = p === "clickup" ? CLICKUP_SVG : "";\n' +
    '  const cls = p === "manual" ? "provbadge manual" : "provbadge";\n' +
    '  const iconHtml = icon ? \'<span class="provicon" aria-hidden="true">\' + icon + \'</span>\' : "";\n' +
    '  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;",\'"\':"&quot;" }[c]));\n' +
    '  return \'<span class="\' + cls + \'">\' + iconHtml + \'<span class="provname">\' + esc(label) + \'</span></span>\';\n' +
    '}\n' +
    // The mark alone, for a chip that already names the board in its own text
    // (the dashboard key pill). Empty for a provider with no mark — the chip
    // then reads as its text alone rather than a hole where an icon should be.
    'function providerIconHtml(provider) {\n' +
    '  const icon = provider === "clickup" ? CLICKUP_SVG : "";\n' +
    '  return icon ? \'<span class="provicon" aria-hidden="true">\' + icon + \'</span>\' : "";\n' +
    '}'
  );
}

/** Replace the provider CSS/JS markers with the emitted blocks; no-op per marker if absent. */
export function injectProviderIdentity(html: string): string {
  return html
    .replace(PROVIDER_CSS_MARKER, providerIdentityCss())
    .replace(PROVIDER_JS_MARKER, providerIdentityJs());
}
