import { randomBytes } from 'node:crypto';

/**
 * Content-Security-Policy for the webviews — the backstop under the `esc()`
 * escaping, not a replacement for it. Every panel runs with `enableScripts:
 * true`, so an escaping regression would otherwise be directly exploitable.
 *
 * The policy is as tight as it is because a webview is otherwise entirely
 * self-contained: no `<link>`, no `url()`, no `@font-face`, no `fetch()`. One
 * exception exists — the onboarding page renders prompt attachments off disk, so
 * it alone is handed a `mediaSource` (the panel's `webview.cspSource`) and gets
 * `img-src`/`media-src` for it. Every other webview passes no source and keeps
 * `default-src 'none'` covering everything, because nothing they load comes from
 * anywhere. The grant is per-panel for that reason: a widened policy applied
 * globally would loosen five documents to buy nothing.
 *
 * Scripts are inline blocks, so they are authorized by nonce. `'unsafe-inline'`
 * must never appear in `script-src`: it re-permits any injected `<script>`,
 * which is precisely what this exists to stop. Styles get `'unsafe-inline'`
 * because inline `<style>` blocks and `style=""` attributes have no nonce path —
 * an accepted, much smaller surface than script.
 */
const POLICY = (nonce: string, mediaSource?: string): string => {
  const parts = [
    "default-src 'none'",
    "style-src 'unsafe-inline'",
    `script-src 'nonce-${nonce}'`,
  ];
  if (mediaSource) {
    parts.push(`img-src ${mediaSource}`, `media-src ${mediaSource}`);
  }
  return `${parts.join('; ')};`;
};

/** The placeholder each webview.html carries where the CSP meta tag belongs. */
export const CSP_MARKER = '<!--KARST_CSP-->';

/**
 * A fresh nonce. Must be per page load, never per module or per host: a nonce
 * reused across loads is a value an attacker can learn once and reuse, which is
 * no better than `'unsafe-inline'`. 128 bits, the CSP spec's floor.
 */
export function newNonce(): string {
  return randomBytes(16).toString('base64');
}

/**
 * Replace the CSP marker with the policy meta tag and authorize the document's
 * inline scripts with `nonce`. No-op when the marker is absent — same contract
 * as `injectPalette`, so a webview that hasn't opted in passes through intact
 * rather than being served a policy that would block its own untagged scripts.
 *
 * Script tags must stay attribute-less (`<script>`): the match is literal, so a
 * `<script type="module">` would silently go untagged and never run. The blunt
 * `replaceAll` also rewrites the literal `<script>` anywhere it appears — inside
 * a JS string or a style block, say — which no webview does today.
 * `ui/webviewCsp.test.ts` holds both of those true.
 */
export function injectCsp(html: string, nonce: string, mediaSource?: string): string {
  if (!html.includes(CSP_MARKER)) return html;
  const meta = `<meta http-equiv="Content-Security-Policy" content="${POLICY(nonce, mediaSource)}" />`;
  return html.replace(CSP_MARKER, meta).replaceAll('<script>', `<script nonce="${nonce}">`);
}
