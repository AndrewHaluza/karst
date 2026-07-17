/**
 * The URL-scheme allowlist every webview must apply before a `url` from a
 * webview message can reach `vscode.env.openExternal`.
 *
 * A webview is a trust boundary: `openExternal` will happily launch `file://`,
 * `vscode://` or a `command:` URI, so a crafted message must be held to http(s)
 * before it gets there. This lives in one module because the guard was
 * previously copied inline per message type, and the copy is exactly how
 * onboarding ended up without it while the dashboard had it.
 *
 * Scheme comparison is case-insensitive per RFC 3986 §3.1 — `HTTPS://…` is a
 * valid https URL, and rejecting it would be a silent false negative for any
 * future provider that emits one. The allowlist stays http/https either way.
 */
const HTTP_SCHEME = /^https?:\/\//i;

/** True when `v` is a string carrying an http(s) URL. Narrows for the caller. */
export function isHttpUrl(v: unknown): v is string {
  return typeof v === 'string' && HTTP_SCHEME.test(v);
}
