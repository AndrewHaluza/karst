/**
 * Provider-agnostic field normalizers shared by the ticketing providers (§15).
 * Pure and dependency-free so they are unit-tested directly and reused wherever
 * a provider needs to normalize a time value or harvest links from free text.
 */

/**
 * Normalize a provider time value to ISO-8601. ClickUp (and most providers)
 * hand back epoch MILLISECONDS as a numeric string; those become an ISO string.
 * A non-numeric, already-formatted value is returned trimmed and untouched.
 * Absent/blank/zero/unparseable input yields undefined — "no date", never a
 * bogus 1970 timestamp.
 */
export function toIsoDate(value: string | number | null | undefined): string | undefined {
  if (value === null || value === undefined) return undefined;
  const raw = String(value).trim();
  if (!raw) return undefined;
  if (/^\d+$/.test(raw)) {
    const ms = Number(raw);
    // A zero (or absurdly small) epoch is ClickUp's "unset", not 1970.
    if (!Number.isFinite(ms) || ms <= 0) return undefined;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
  }
  // Already a formatted string (ISO, RFC, etc.) — keep as-is.
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? raw : d.toISOString();
}

// A URL run: http(s)://, up to the first whitespace or a markdown/paren closer.
const URL_RE = /\bhttps?:\/\/[^\s<>()[\]"']+/gi;

/**
 * Harvest distinct http(s) links embedded in free text (a description). Trailing
 * sentence punctuation is trimmed so "see https://x/y." yields "https://x/y".
 * Order-preserving and de-duplicated; returns [] when the text carries no links.
 */
export function extractLinks(text: string | undefined): string[] {
  if (!text) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const match of text.match(URL_RE) ?? []) {
    const url = match.replace(/[.,;:!?]+$/, '');
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push(url);
  }
  return out;
}
