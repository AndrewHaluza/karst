/**
 * Request-target policy of the host OAuth proxy (@arch:AC-51). The proxy has one
 * fixed upstream; the guest picks only a path. Only the paths Claude Code uses
 * for inference are allowed (found in the claude binary, not guessed).
 */

export type TargetCheck =
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly reason: 'absolute' | 'traversal' | 'encoded' | 'path' };

const ALLOWED_PATHS: readonly RegExp[] = [
  /^\/v1\/messages$/,
  /^\/v1\/messages\/(count_tokens|cache_touch)$/,
  /^\/v1\/messages\/batches(\/[A-Za-z0-9_-]+(\/(results|cancel))?)?$/,
  /^\/v1\/complete$/,
  /^\/v1\/models(\/[A-Za-z0-9._:-]+)?$/,
];

/** Validate a raw request target (`req.url`). The query string is not inspected. */
export function checkRequestTarget(target: string): TargetCheck {
  if (!target.startsWith('/') || target.startsWith('//')) return { ok: false, reason: 'absolute' };
  const path = target.split('?', 1)[0] as string;
  if (/%(2e|2f|5c|00)/i.test(path) || path.includes('\\') || /%[^0-9a-f]|%.[^0-9a-f]/i.test(path)) return { ok: false, reason: 'encoded' };
  if (path.split('/').some((segment) => segment === '..' || segment === '.')) return { ok: false, reason: 'traversal' };
  if (!ALLOWED_PATHS.some((re) => re.test(path))) return { ok: false, reason: 'path' };
  return { ok: true, path };
}
